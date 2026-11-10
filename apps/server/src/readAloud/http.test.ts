// @effect-diagnostics globalFetch:off globalFetchInEffect:off globalJsonInEffect:off - the route is driven by a real client.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MessageId,
  TextGenerationError,
  ThreadId,
  type AuthEnvironmentScope,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import { expect } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { fakeHearsay, type FakeHearsayScript } from "./fakeHearsay.ts";
import {
  READ_ALOUD_DICTATED_PATH,
  READ_ALOUD_SAMPLE_RATE_HEADER,
  READ_ALOUD_SPEAK_PATH,
  readAloudRoutes,
  utteranceStreamPrefix,
} from "./http.ts";
import * as ReadAloud from "./ReadAloudService.ts";

const THREAD = ThreadId.make("thread-1");
const REPLY = MessageId.make("reply-1");
const STREAMING = MessageId.make("reply-2");
const USER = MessageId.make("user-1");
const NOW = DateTime.makeUnsafe(0);

const message = (
  id: MessageId,
  role: "user" | "assistant",
  text: string,
  streaming = false,
): OrchestrationV2ConversationMessage =>
  ({
    id,
    threadId: THREAD,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming,
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as OrchestrationV2ConversationMessage;

const REPLY_TEXT = "Done.\n\n```sh\nrm -rf build\n```\n\nPush it.";
const messages = [
  message(USER, "user", "Please build."),
  message(REPLY, "assistant", REPLY_TEXT),
  message(STREAMING, "assistant", "Still going", true),
];

const principal = (...scopes: AuthEnvironmentScope[]) =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: "session" as never,
        subject: "test",
        method: "bearer-access-token",
        scopes,
      }),
  });

const projections = Layer.mock(ProjectionStoreV2.ProjectionStoreV2)({
  getMessagesById: (threadId, ids) =>
    threadId === THREAD
      ? Effect.succeed(new Map(messages.filter((m) => ids.includes(m.id)).map((m) => [m.id, m])))
      : Effect.fail(new ProjectionStoreV2.ProjectionStoreThreadNotFoundError({ threadId })),
  getThread: (threadId) =>
    threadId === THREAD
      ? Effect.succeed({ id: THREAD, forkedFrom: null } as never)
      : Effect.fail(new ProjectionStoreV2.ProjectionStoreThreadNotFoundError({ threadId })),
});

const SUMMARY = "Build fixed. Run the tests.";
/** The summary model: a fixed sentence, or a failure when `summaryFails`. */
const summariser = (summaryFails: boolean) =>
  Layer.mock(TextGeneration.TextGeneration)({
    generateTranscriptionPostProcessing: () =>
      summaryFails
        ? Effect.fail(
            new TextGenerationError({
              operation: "generateTranscriptionPostProcessing",
              detail: "claude is not installed",
            }),
          )
        : Effect.succeed({ transcription: SUMMARY }),
  });

const withRoute = Effect.fn("test.readAloud.withRoute")(function* (
  hearsay: { url?: string; token?: string },
  scopes: AuthEnvironmentScope[] = [AuthOrchestrationOperateScope],
  summaryFails = false,
) {
  const routes = readAloudRoutes.pipe(
    Layer.provide(
      ReadAloud.layer.pipe(
        Layer.provide(projections),
        Layer.provide(ServerSettings.layerTest({ hearsaySpeech: hearsay })),
        Layer.provide(summariser(summaryFails)),
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provide(principal(...scopes)),
    ),
  );
  const server = yield* HttpServer.HttpServer;
  const address = server.address as NetAddress.InetAddress;
  const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
  const origin = `http://${host}:${address.port}`;
  return (body: unknown, signal?: AbortSignal, path: string = READ_ALOUD_SPEAK_PATH) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
});

const serve = (script?: FakeHearsayScript) => fakeHearsay(script);

/** The body as the client reads it: the rate prefix, then the PCM. */
const withPrefix = (sampleRate: number, pcm: ReadonlyArray<number>) =>
  new Uint8Array([...utteranceStreamPrefix(sampleRate), ...pcm]);

const errorOf = (response: Response) =>
  Effect.promise(() => response.json() as Promise<{ error: string }>).pipe(
    Effect.map((body) => body.error),
  );

it.live("streams a reply's speech with its code blocks never sent to Hearsay", () =>
  Effect.gen(function* () {
    const chunks = [new Uint8Array([1, 0, 2, 0]), new Uint8Array([3, 0])];
    const hearsay = yield* serve({ sampleRate: 24_000, chunks });
    const post = yield* withRoute({ url: hearsay.url, token: "secret" });
    const response = yield* Effect.promise(() => post({ threadId: THREAD, messageId: REPLY }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(response.headers.get(READ_ALOUD_SAMPLE_RATE_HEADER)).toBe("24000");
    const body = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()));
    expect(body).toEqual(withPrefix(24_000, [1, 0, 2, 0, 3, 0]));
    expect(hearsay.received).toEqual([
      { type: "start" },
      { type: "text", text: "Done.\n\nPush it." },
      { type: "end" },
    ]);
    expect(JSON.stringify(hearsay.received)).not.toContain("rm -rf");
    expect(hearsay.handshakes[0]!.authorization).toBe("Bearer secret");
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("speaks the summary of a reply in summary mode, and 502 when it cannot be made", () =>
  Effect.gen(function* () {
    const hearsay = yield* serve({ sampleRate: 24_000, chunks: [new Uint8Array([1, 0])] });
    const post = yield* withRoute({ url: hearsay.url });
    const response = yield* Effect.promise(() =>
      post({ threadId: THREAD, messageId: REPLY, mode: "summary" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get(READ_ALOUD_SAMPLE_RATE_HEADER)).toBe("24000");
    expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(
      withPrefix(24_000, [1, 0]),
    );
    expect(hearsay.received).toEqual([
      { type: "start" },
      { type: "text", text: SUMMARY },
      { type: "end" },
    ]);
    const failing = yield* withRoute({ url: hearsay.url }, [AuthOrchestrationOperateScope], true);
    const failed = yield* Effect.promise(() =>
      failing({ threadId: THREAD, messageId: REPLY, mode: "summary" }),
    );
    expect(failed.status).toBe(502);
    expect(yield* errorOf(failed)).toBe("The summary could not be made: claude is not installed");
    expect(hearsay.handshakes).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("answers 409 with a plain sentence and opens no socket without a Hearsay URL", () =>
  Effect.gen(function* () {
    const hearsay = yield* serve();
    const post = yield* withRoute({ url: "" });
    const response = yield* Effect.promise(() => post({ threadId: THREAD, messageId: REPLY }));
    expect(response.status).toBe(409);
    expect(yield* errorOf(response)).toBe(
      "Set a Hearsay URL on the Voice page to read replies aloud.",
    );
    expect(hearsay.handshakes).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("answers 502 with a plain sentence when Hearsay is unreachable", () =>
  Effect.gen(function* () {
    const post = yield* withRoute({ url: "http://127.0.0.1:9" });
    const response = yield* Effect.promise(() => post({ threadId: THREAD, messageId: REPLY }));
    expect(response.status).toBe(502);
    expect(yield* errorOf(response)).toContain("Hearsay at http://127.0.0.1:9 did not answer: ");
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("answers 404, 409 and 400 for a reply it cannot read, and 403 without the scope", () =>
  Effect.gen(function* () {
    const hearsay = yield* serve();
    const post = yield* withRoute({ url: hearsay.url });
    const unknownThread = yield* Effect.promise(() =>
      post({ threadId: "thread-2", messageId: REPLY }),
    );
    expect(unknownThread.status).toBe(404);
    const userMessage = yield* Effect.promise(() => post({ threadId: THREAD, messageId: USER }));
    expect(userMessage.status).toBe(404);
    expect(yield* errorOf(userMessage)).toBe("There is no such reply in this thread.");
    const streaming = yield* Effect.promise(() => post({ threadId: THREAD, messageId: STREAMING }));
    expect(streaming.status).toBe(409);
    expect(yield* errorOf(streaming)).toBe("This reply is still being written.");
    const malformed = yield* Effect.promise(() => post("{"));
    expect(malformed.status).toBe(400);
    const readOnly = yield* withRoute({ url: hearsay.url }, [AuthOrchestrationReadScope]);
    const forbidden = yield* Effect.promise(() => readOnly({ threadId: THREAD, messageId: REPLY }));
    expect(forbidden.status).toBe(403);
    expect(hearsay.handshakes).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("cancels the utterance on Hearsay's socket when the client aborts", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const hearsay = yield* serve({
      chunks: [new Uint8Array([1, 0]), new Uint8Array([2, 0])],
      gate,
    });
    const post = yield* withRoute({ url: hearsay.url });
    const response = yield* Effect.promise(() => post({ threadId: THREAD, messageId: REPLY }));
    const reader = response.body!.getReader();
    // The prefix and the first chunk, whether they arrive together or apart.
    const expected = withPrefix(24_000, [1, 0]);
    let seen = new Uint8Array(0);
    while (seen.byteLength < expected.byteLength) {
      const next = yield* Effect.promise(() => reader.read());
      seen = new Uint8Array([...seen, ...(next.value ?? [])]);
      if (next.done) break;
    }
    expect(seen).toEqual(expected);
    // Cancelling the body reader aborts the request, as a client going away does.
    yield* Effect.promise(() => reader.cancel());
    yield* Deferred.await(hearsay.cancelled);
    expect(hearsay.received.at(-1)).toEqual({ type: "cancel" });
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("cancels on Hearsay's socket when the client gives up while the voice still loads", () =>
  Effect.gen(function* () {
    const holdFormat = yield* Deferred.make<void>();
    const hearsay = yield* serve({ holdFormat });
    const post = yield* withRoute({ url: hearsay.url });
    const ended = yield* Deferred.make<void>();
    hearsay.onMessage = (message) => {
      if (message.type === "end") Deferred.doneUnsafe(ended, Effect.void);
    };
    // Effect.promise's signal aborts the fetch when the race interrupts it, as a client that stops does.
    const request = Effect.promise((signal) =>
      post({ threadId: THREAD, messageId: REPLY }, signal),
    );
    const winner = yield* Effect.raceFirst(
      request.pipe(Effect.map((response) => `answered ${response.status}`)),
      Deferred.await(ended).pipe(Effect.as("stopped" as const)),
    );
    expect(winner).toBe("stopped");
    yield* Deferred.await(hearsay.cancelled);
    expect(hearsay.received.map((message) => message.type)).toEqual([
      "start",
      "text",
      "end",
      "cancel",
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** A hotkey dictation Hearsay finished half a minute before `nowMs`. */
const recent = (nowMs: number, text: string, source = "dictate") => ({
  id: "entry-1",
  started_at: iso(nowMs - 32_000),
  ended_at: iso(nowMs - 30_000),
  state: "done",
  source,
  text,
  raw: text,
  partial: text,
  suspect: false,
  suspect_reason: null,
  failure: null,
  audio_seconds: 2.0,
  sound_seconds: 1.5,
  audio_kept: true,
});

it.live(
  "says whether a message holds a recent hotkey dictation, without sending it to Hearsay",
  () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const hearsay = yield* serve({ history: [recent(now, "Fix the build.")] });
      const post = yield* withRoute({ url: hearsay.url, token: "secret" });
      const ask = (body: unknown) =>
        Effect.promise(() => post(body, undefined, READ_ALOUD_DICTATED_PATH));
      const dictated = yield* ask({ text: "Fix the build. Then push." });
      expect(dictated.status).toBe(200);
      expect(yield* Effect.promise(() => dictated.json())).toEqual({ dictated: true });
      const typed = yield* ask({ text: "Run the tests." });
      expect(yield* Effect.promise(() => typed.json())).toEqual({ dictated: false });
      expect(hearsay.historyRequests.map((request) => request.url)).toEqual([
        "/v1/history?limit=5",
        "/v1/history?limit=5",
      ]);
      expect(hearsay.historyRequests[0]!.headers.authorization).toBe("Bearer secret");
      expect(hearsay.handshakes).toEqual([]);
      const bad = yield* ask({ words: "Fix the build." });
      expect(bad.status).toBe(400);
      expect(yield* errorOf(bad)).toBe("The request must carry the message's text.");
      const readOnly = yield* withRoute({ url: hearsay.url }, [AuthOrchestrationReadScope]);
      const forbidden = yield* Effect.promise(() =>
        readOnly({ text: "Fix the build." }, undefined, READ_ALOUD_DICTATED_PATH),
      );
      expect(forbidden.status).toBe(403);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("answers false, with no request, when no Hearsay URL is set", () =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const hearsay = yield* serve({ history: [recent(now, "Fix the build.")] });
    const post = yield* withRoute({ url: "" });
    const response = yield* Effect.promise(() =>
      post({ text: "Fix the build." }, undefined, READ_ALOUD_DICTATED_PATH),
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ dictated: false });
    expect(hearsay.historyRequests).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
