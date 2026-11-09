// @effect-diagnostics nodeBuiltinImport:off - the summary's scoped working directory is checked on disk.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  TextGenerationError,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type ServerSettings as ServerSettingsShape,
} from "@t3tools/contracts";
import type { TranscriptionPostProcessingInput } from "@t3tools/provider-core/server/textGeneration";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { fakeHearsay, type FakeHearsayScript } from "./fakeHearsay.ts";
import * as ReadAloud from "./ReadAloudService.ts";
import { READ_ALOUD_SUMMARY_INSTRUCTIONS } from "./summaryPrompt.ts";

const THREAD = ThreadId.make("thread-1");
const FORK = ThreadId.make("thread-fork");
const FORK_OF_FORK = ThreadId.make("thread-fork-2");
const REPLY = MessageId.make("reply-1");
const STREAMING = MessageId.make("reply-2");
const CODE_ONLY = MessageId.make("reply-3");
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

const OWN_REPLY = MessageId.make("reply-fork-1");
const messagesByThread = new Map<ThreadId, ReadonlyArray<OrchestrationV2ConversationMessage>>([
  [
    THREAD,
    [
      message(USER, "user", "Please build."),
      message(REPLY, "assistant", "Done.\n\n```sh\nrm -rf build\n```\n\nPush it."),
      message(STREAMING, "assistant", "Still going", true),
      message(CODE_ONLY, "assistant", "```\nonly code\n```"),
    ],
  ],
  [FORK, [message(OWN_REPLY, "assistant", "Forked and done.")]],
  [FORK_OF_FORK, []],
]);
const forkedFrom = new Map<ThreadId, OrchestrationV2AppThread["forkedFrom"]>([
  [THREAD, null],
  [FORK, { type: "run", threadId: THREAD, runId: RunId.make("run-1") }],
  [FORK_OF_FORK, { type: "run", threadId: FORK, runId: RunId.make("run-fork-1") }],
]);

/** The projection store the service reads: a thread, a fork of it and a fork of that. */
export const projections = Layer.mock(ProjectionStoreV2.ProjectionStoreV2)({
  getMessagesById: (threadId, ids) => {
    const messages = messagesByThread.get(threadId);
    if (messages === undefined)
      return Effect.fail(new ProjectionStoreV2.ProjectionStoreThreadNotFoundError({ threadId }));
    return Effect.succeed(
      new Map(messages.filter((candidate) => ids.includes(candidate.id)).map((m) => [m.id, m])),
    );
  },
  getThread: (threadId) =>
    forkedFrom.has(threadId)
      ? Effect.succeed({ id: threadId, forkedFrom: forkedFrom.get(threadId) } as never)
      : Effect.fail(new ProjectionStoreV2.ProjectionStoreThreadNotFoundError({ threadId })),
});

/** The summary model: answers `summary`, or fails with `failure`, and records what it was asked. */
const summariser = (script: { summary?: string; failure?: string }) => {
  const calls: TranscriptionPostProcessingInput[] = [];
  const layer = Layer.mock(TextGeneration.TextGeneration)({
    generateTranscriptionPostProcessing: (input) => {
      calls.push(input);
      return script.failure === undefined
        ? Effect.succeed({ transcription: script.summary ?? "" })
        : Effect.fail(
            new TextGenerationError({
              operation: "generateTranscriptionPostProcessing",
              detail: script.failure,
            }),
          );
    },
  });
  return { calls, layer };
};

type SettingsOverrides = Parameters<typeof ServerSettings.layerTest>[0];

const layerFor = (
  hearsay: { url?: string; token?: string },
  options: {
    settings?: SettingsOverrides;
    textGeneration?: Layer.Layer<TextGeneration.TextGeneration>;
  } = {},
) =>
  ReadAloud.layer.pipe(
    Layer.provide(projections),
    Layer.provide(ServerSettings.layerTest({ ...options.settings, hearsaySpeech: hearsay })),
    Layer.provide(options.textGeneration ?? summariser({ summary: "Done." }).layer),
    Layer.provide(NodeServices.layer),
  );

const speakThrough = (hearsay: { url?: string; token?: string }, text: string) =>
  ReadAloud.ReadAloudService.pipe(
    Effect.flatMap((service) => service.speak(text)),
    Effect.provide(layerFor(hearsay)),
  );

const collect = (hearsay: { url?: string; token?: string }, text: string) =>
  speakThrough(hearsay, text).pipe(
    Effect.flatMap((utterance) =>
      Stream.runCollect(utterance.audio).pipe(
        Effect.map((chunks) => ({ sampleRate: utterance.sampleRate, chunks })),
      ),
    ),
  );

const serve = (script?: FakeHearsayScript) => fakeHearsay(script);

it.live("speaks the text in Hearsay's wire order and yields the PCM as it arrives", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const first = new Uint8Array([1, 0, 2, 0]);
    const second = new Uint8Array([3, 0]);
    const hearsay = yield* serve({ sampleRate: 16_000, chunks: [first, second], gate });
    const utterance = yield* speakThrough({ url: `${hearsay.url}/`, token: "secret" }, "Hello.");
    expect(utterance.sampleRate).toBe(16_000);
    const received: Uint8Array[] = [];
    yield* Stream.runForEach(utterance.audio, (chunk) =>
      Effect.gen(function* () {
        received.push(chunk);
        if (received.length === 1) {
          // The second chunk is not sent until the gate opens, so the first was not buffered.
          expect(hearsay.received.map((message) => message.type)).toEqual(["start", "text", "end"]);
          yield* Deferred.succeed(gate, undefined);
        }
      }),
    );
    expect(received).toEqual([first, second]);
    expect(hearsay.received).toEqual([
      { type: "start" },
      { type: "text", text: "Hello." },
      { type: "end" },
    ]);
    const handshake = hearsay.handshakes[0]!;
    expect(handshake.authorization).toBe("Bearer secret");
    expect(handshake.origin).toBeUndefined();
  }).pipe(Effect.scoped),
);

it.live("sends no token header when none is set and a large chunk arrives whole", () =>
  Effect.gen(function* () {
    const large = new Uint8Array(600 * 1024).map((_, index) => index % 251);
    const hearsay = yield* serve({ chunks: [large] });
    const { chunks } = yield* collect({ url: hearsay.url }, "A long reply.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.byteLength).toBe(large.byteLength);
    expect(chunks[0]).toEqual(large);
    expect(hearsay.handshakes[0]!.authorization).toBeUndefined();
  }).pipe(Effect.scoped),
);

it.live("cancels the utterance when the scope closes before the speech ends", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const hearsay = yield* serve({
      chunks: [new Uint8Array([1, 0]), new Uint8Array([2, 0])],
      gate,
    });
    const scope = yield* Scope.make();
    const utterance = yield* speakThrough({ url: hearsay.url }, "Hello.").pipe(
      Scope.provide(scope),
    );
    const first = yield* Stream.runHead(utterance.audio);
    expect(first._tag === "Some" ? first.value : undefined).toEqual(new Uint8Array([1, 0]));
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.await(hearsay.cancelled);
    expect(hearsay.received.at(-1)).toEqual({ type: "cancel" });
  }).pipe(Effect.scoped),
);

it.live("does not cancel an utterance that ended", () =>
  Effect.gen(function* () {
    const hearsay = yield* serve();
    const scope = yield* Scope.make();
    const utterance = yield* speakThrough({ url: hearsay.url }, "Hello.").pipe(
      Scope.provide(scope),
    );
    yield* Stream.runDrain(utterance.audio);
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.await(hearsay.finished);
    expect(hearsay.received.map((message) => message.type)).toEqual(["start", "text", "end"]);
  }).pipe(Effect.scoped),
);

it.live("fails with Hearsay's own error sentence", () =>
  Effect.gen(function* () {
    const hearsay = yield* serve({ error: "There is no voice named 'nobody'." });
    const error = yield* collect({ url: hearsay.url }, "Hello.").pipe(Effect.flip);
    expect(error).toBeInstanceOf(ReadAloud.ReadAloudHearsayError);
    expect(error.message).toBe(
      `Hearsay at ${hearsay.url} did not answer: There is no voice named 'nobody'.`,
    );
  }).pipe(Effect.scoped),
);

it.live("fails when the socket closes before done", () =>
  Effect.gen(function* () {
    const hearsay = yield* serve({ closeAfterChunks: 1012 });
    const error = yield* collect({ url: hearsay.url }, "Hello.").pipe(Effect.flip);
    expect(error.message).toBe(
      `Hearsay at ${hearsay.url} did not answer: the socket closed (code 1012) before the speech ended`,
    );
  }).pipe(Effect.scoped),
);

it.live("fails plainly when Hearsay is unreachable or refuses the handshake", () =>
  Effect.gen(function* () {
    const unreachable = yield* collect({ url: "http://127.0.0.1:9" }, "Hello.").pipe(Effect.flip);
    expect(unreachable.message).toBe(
      "Hearsay at http://127.0.0.1:9 did not answer: the connection was refused or the handshake failed",
    );
    const refusing = yield* serve({ refuse: true });
    const refused = yield* collect({ url: refusing.url }, "Hello.").pipe(Effect.flip);
    expect(refused).toBeInstanceOf(ReadAloud.ReadAloudHearsayError);
    expect(refused.message).toContain(`Hearsay at ${refusing.url} did not answer: `);
    expect(refusing.received).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live("speaks a reply from the projection with its code blocks never sent", () =>
  Effect.gen(function* () {
    const hearsay = yield* serve();
    const chunks = yield* ReadAloud.ReadAloudService.pipe(
      Effect.flatMap((service) => service.speakReply(THREAD, REPLY)),
      Effect.flatMap((utterance) => Stream.runCollect(utterance.audio)),
      Effect.provide(layerFor({ url: hearsay.url })),
    );
    expect(chunks).toHaveLength(1);
    expect(hearsay.received).toEqual([
      { type: "start" },
      { type: "text", text: "Done.\n\nPush it." },
      { type: "end" },
    ]);
  }).pipe(Effect.scoped),
);

it.live("reads a reply a forked thread inherited from the thread it was forked from", () =>
  Effect.gen(function* () {
    const hearsay = yield* serve();
    const spoken = (threadId: ThreadId, messageId: MessageId) =>
      ReadAloud.ReadAloudService.pipe(
        Effect.flatMap((service) => service.speakReply(threadId, messageId)),
        Effect.flatMap((utterance) => Stream.runDrain(utterance.audio)),
        Effect.provide(layerFor({ url: hearsay.url })),
        Effect.map(() => hearsay.received.at(-2)),
      );
    expect(yield* spoken(FORK, REPLY)).toEqual({ type: "text", text: "Done.\n\nPush it." });
    expect(yield* spoken(FORK_OF_FORK, REPLY)).toEqual({ type: "text", text: "Done.\n\nPush it." });
    expect(yield* spoken(FORK, OWN_REPLY)).toEqual({ type: "text", text: "Forked and done." });
  }).pipe(Effect.scoped),
);

it.live("refuses a reply it cannot read before opening a socket", () =>
  Effect.gen(function* () {
    const hearsay = yield* serve();
    const failing = (threadId: ThreadId, messageId: MessageId) =>
      ReadAloud.ReadAloudService.pipe(
        Effect.flatMap((service) => service.speakReply(threadId, messageId)),
        Effect.provide(layerFor({ url: hearsay.url })),
        Effect.flip,
      );
    expect(yield* failing(ThreadId.make("thread-2"), REPLY)).toBeInstanceOf(
      ReadAloud.ReadAloudReplyNotFoundError,
    );
    expect(yield* failing(THREAD, USER)).toBeInstanceOf(ReadAloud.ReadAloudReplyNotFoundError);
    expect(yield* failing(THREAD, STREAMING)).toBeInstanceOf(
      ReadAloud.ReadAloudReplyStreamingError,
    );
    expect(yield* failing(THREAD, CODE_ONLY)).toBeInstanceOf(ReadAloud.ReadAloudNothingToReadError);
    expect(hearsay.handshakes).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live("opens nothing when no Hearsay URL is set", () =>
  Effect.gen(function* () {
    const hearsay = yield* serve();
    const error = yield* collect({ url: "" }, "Hello.").pipe(Effect.flip);
    expect(error).toBeInstanceOf(ReadAloud.ReadAloudNotConfiguredError);
    expect(error.message).toBe("Set a Hearsay URL on the Voice page to read replies aloud.");
    expect(hearsay.handshakes).toEqual([]);
  }).pipe(Effect.scoped),
);

const speakSummaryThrough = (
  hearsayUrl: string,
  options: Parameters<typeof layerFor>[1],
  threadId = THREAD,
  messageId = REPLY,
) =>
  ReadAloud.ReadAloudService.pipe(
    Effect.flatMap((service) => service.speakSummary(threadId, messageId)),
    Effect.flatMap((utterance) => Stream.runDrain(utterance.audio)),
    Effect.provide(layerFor({ url: hearsayUrl }, options)),
  );

it.live("speaks a summary of the reply made by Claude Haiku, its stray marks dropped", () =>
  Effect.gen(function* () {
    const hearsay = yield* serve();
    const model = summariser({ summary: "**Done.** The build is `green`.\n\nPush it when ready." });
    yield* speakSummaryThrough(hearsay.url, { textGeneration: model.layer });
    expect(hearsay.received).toEqual([
      { type: "start" },
      { type: "text", text: "Done. The build is green.\n\nPush it when ready." },
      { type: "end" },
    ]);
    expect(model.calls).toHaveLength(1);
    const call = model.calls[0]!;
    // Pinned to the Claude instance and Haiku whatever the server's text generation model is.
    expect(call.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-haiku-5-5" });
    expect(call.prompt.startsWith(READ_ALOUD_SUMMARY_INSTRUCTIONS)).toBe(true);
    expect(call.prompt).toContain(
      "<reply>\nDone.\n\n```sh\nrm -rf build\n```\n\nPush it.\n</reply>",
    );
    // The model ran in a scoped scratch directory, gone once the summary was made.
    expect(call.cwd).toContain("t3-read-aloud-summary-");
    expect(NodeFS.existsSync(call.cwd)).toBe(false);
  }).pipe(Effect.scoped),
);

it.live("falls back to the server's text generation model when no Claude instance is enabled", () =>
  Effect.gen(function* () {
    const hearsay = yield* serve();
    const model = summariser({ summary: "Done." });
    const selection = { instanceId: "codex", model: "gpt-6-luna" };
    yield* speakSummaryThrough(hearsay.url, {
      textGeneration: model.layer,
      settings: {
        providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: false } },
        textGenerationModelSelection: selection,
      } as unknown as Partial<ServerSettingsShape>,
    });
    expect(model.calls[0]!.modelSelection).toMatchObject(selection);
  }).pipe(Effect.scoped),
);

it.live("fails plainly, with no socket opened, when the summary cannot be made", () =>
  Effect.gen(function* () {
    const hearsay = yield* serve();
    const failing = summariser({ failure: "claude is not installed" });
    const error = yield* speakSummaryThrough(hearsay.url, { textGeneration: failing.layer }).pipe(
      Effect.flip,
    );
    expect(error).toBeInstanceOf(ReadAloud.ReadAloudSummaryError);
    expect(error.message).toBe("The summary could not be made: claude is not installed");
    // A reply with nothing to read is refused before the model is asked.
    const model = summariser({ summary: "Done." });
    const nothing = yield* speakSummaryThrough(
      hearsay.url,
      { textGeneration: model.layer },
      THREAD,
      CODE_ONLY,
    ).pipe(Effect.flip);
    expect(nothing).toBeInstanceOf(ReadAloud.ReadAloudNothingToReadError);
    expect(model.calls).toEqual([]);
    expect(hearsay.handshakes).toEqual([]);
  }).pipe(Effect.scoped),
);
