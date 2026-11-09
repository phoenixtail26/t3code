// @effect-diagnostics globalFetch:off globalFetchInEffect:off globalJsonInEffect:off - the route is driven by a real client.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MessageId,
  ThreadId,
  type AuthEnvironmentScope,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import { expect } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { fakeHearsay, type FakeHearsayScript } from "./fakeHearsay.ts";
import { READ_ALOUD_SAMPLE_RATE_HEADER, READ_ALOUD_SPEAK_PATH, readAloudRoutes } from "./http.ts";
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
const projection = {
  messages: [
    message(USER, "user", "Please build."),
    message(REPLY, "assistant", REPLY_TEXT),
    message(STREAMING, "assistant", "Still going", true),
  ],
} as unknown as OrchestrationV2ThreadProjection;

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
  getThreadProjection: (threadId) =>
    threadId === THREAD
      ? Effect.succeed(projection)
      : Effect.fail(new ProjectionStoreV2.ProjectionStoreThreadNotFoundError({ threadId })),
});

const withRoute = Effect.fn("test.readAloud.withRoute")(function* (
  hearsay: { url?: string; token?: string },
  scopes: AuthEnvironmentScope[] = [AuthOrchestrationOperateScope],
) {
  const routes = readAloudRoutes.pipe(
    Layer.provide(projections),
    Layer.provide(ReadAloud.layer),
    Layer.provide(ServerSettings.layerTest({ hearsaySpeech: hearsay })),
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
  const url = `http://${host}:${address.port}${READ_ALOUD_SPEAK_PATH}`;
  return (body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
});

const serve = (script?: FakeHearsayScript) => fakeHearsay(script);

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
    expect(body).toEqual(new Uint8Array([1, 0, 2, 0, 3, 0]));
    expect(hearsay.received).toEqual([
      { type: "start" },
      { type: "text", text: "Done.\n\nPush it." },
      { type: "end" },
    ]);
    expect(JSON.stringify(hearsay.received)).not.toContain("rm -rf");
    expect(hearsay.handshakes[0]!.authorization).toBe("Bearer secret");
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
    const first = yield* Effect.promise(() => reader.read());
    expect(first.value).toEqual(new Uint8Array([1, 0]));
    // Cancelling the body reader aborts the request, as a client going away does.
    yield* Effect.promise(() => reader.cancel());
    yield* Deferred.await(hearsay.cancelled);
    expect(hearsay.received.at(-1)).toEqual({ type: "cancel" });
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
