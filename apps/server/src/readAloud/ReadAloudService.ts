// Fork feature: read aloud. A reply is read from the projection and its words spoken as one
// utterance through Hearsay's `WS /v1/speak`: the text goes in whole, the PCM comes back as
// Hearsay makes it, and closing the scope early cancels it.
import type { MessageId, OrchestrationV2ConversationMessage, ThreadId } from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { speakableText } from "./speakableText.ts";

const OPEN_TIMEOUT = Duration.seconds(10);
// Covers the voice's load on first use (105 s measured in a fresh Hearsay process on a cold
// disk cache; under 2 s once it has loaded before); `format` comes only once the model is ready.
const FORMAT_TIMEOUT = Duration.minutes(3);
// Hearsay speaks a sentence at a time; on a CPU a long one takes a few seconds.
const CHUNK_TIMEOUT = Duration.seconds(60);
// Under Hearsay's 1 MiB message limit, counted in bytes, whatever the characters.
const TEXT_PIECE_CHARS = 64 * 1024;

export class ReadAloudNotConfiguredError extends Schema.TaggedError<
  ReadAloudNotConfiguredError,
  { readonly brand: unique symbol }
>()("ReadAloudNotConfiguredError", {}) {
  override get message(): string {
    return "Set a Hearsay URL on the Voice page to read replies aloud.";
  }
}

export class ReadAloudHearsayError extends Schema.TaggedError<
  ReadAloudHearsayError,
  { readonly brand: unique symbol }
>()("ReadAloudHearsayError", { url: Schema.String, reason: Schema.String }) {
  override get message(): string {
    return `Hearsay at ${this.url} did not answer: ${this.reason}`;
  }
}

export class ReadAloudReplyNotFoundError extends Schema.TaggedError<
  ReadAloudReplyNotFoundError,
  { readonly brand: unique symbol }
>()("ReadAloudReplyNotFoundError", { threadId: Schema.String, messageId: Schema.String }) {
  override get message(): string {
    return "There is no such reply in this thread.";
  }
}

export class ReadAloudReplyStreamingError extends Schema.TaggedError<
  ReadAloudReplyStreamingError,
  { readonly brand: unique symbol }
>()("ReadAloudReplyStreamingError", { messageId: Schema.String }) {
  override get message(): string {
    return "This reply is still being written.";
  }
}

export class ReadAloudNothingToReadError extends Schema.TaggedError<
  ReadAloudNothingToReadError,
  { readonly brand: unique symbol }
>()("ReadAloudNothingToReadError", { messageId: Schema.String }) {
  override get message(): string {
    return "There is nothing to read in this reply.";
  }
}

type SpeakError = ReadAloudNotConfiguredError | ReadAloudHearsayError;
type SpeakReplyError =
  | SpeakError
  | ReadAloudReplyNotFoundError
  | ReadAloudReplyStreamingError
  | ReadAloudNothingToReadError
  | Exclude<
      ProjectionStoreV2.ProjectionStoreV2Error,
      { readonly _tag: "ProjectionStoreThreadNotFoundError" }
    >;

// A forked thread shows its parent's replies; the chain is followed this far before giving up.
const MAX_FORK_HOPS = 16;

interface Utterance {
  readonly sampleRate: number;
  /** Mono Int16 little-endian PCM at `sampleRate`, chunk by chunk as Hearsay sends it. */
  readonly audio: Stream.Stream<Uint8Array, ReadAloudHearsayError>;
}

export class ReadAloudService extends Context.Service<
  ReadAloudService,
  {
    /**
     * Speaks `text` through Hearsay. The socket lives in the scope: closing it before the
     * audio ends sends `cancel`, so a client that goes away stops the voice.
     */
    readonly speak: (text: string) => Effect.Effect<Utterance, SpeakError, Scope.Scope>;
    /** Reads the assistant reply from the thread's projection and speaks its words, code left out. */
    readonly speakReply: (
      threadId: ThreadId,
      messageId: MessageId,
    ) => Effect.Effect<Utterance, SpeakReplyError, Scope.Scope>;
  }
>()("t3/readAloud/ReadAloudService") {}

const HearsayMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("format"), sample_rate: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("done") }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(HearsayMessage));

// Effect drops its listeners before closing a socket that is still connecting, and undici
// then emits an `error` nobody handles, which would exit the server.
const webSocketConstructor = Layer.effect(
  Socket.WebSocketConstructor,
  Effect.gen(function* () {
    const make = yield* Socket.WebSocketConstructor;
    return (url, options) => {
      const socket = make(url, options);
      socket.addEventListener("error", () => undefined);
      return socket;
    };
  }),
).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));

/** A refused connection or a handshake refusal, in a few words, from the end of the cause chain. */
const describe = (error: Socket.SocketError): string => {
  if (error.reason._tag === "SocketCloseError")
    return `the socket closed (code ${error.reason.code}) before the speech ended`;
  let current: unknown = error.reason;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof Error && current.cause !== undefined) current = current.cause;
    else if (typeof current === "object" && current !== null && "error" in current)
      current = (current as { error: unknown }).error;
    else break;
  }
  if (current instanceof Error) {
    const code = "code" in current && typeof current.code === "string" ? current.code : "";
    if (current.message || code) return current.message || code;
  }
  // undici reports a refused connection and a refused handshake alike, as an empty TypeError.
  return error.reason._tag === "SocketOpenError"
    ? "the connection was refused or the handshake failed"
    : error.reason._tag;
};

const pieces = (text: string): ReadonlyArray<string> => {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += TEXT_PIECE_CHARS)
    out.push(text.slice(at, at + TEXT_PIECE_CHARS));
  return out;
};

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStoreV2.ProjectionStoreV2;

  const speak = Effect.fn("ReadAloudService.speak")(function* (text: string) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const url = settings.hearsaySpeech.url.replace(/\/+$/, "");
    if (!url) return yield* new ReadAloudNotConfiguredError();
    const token = settings.hearsaySpeech.token;
    const fail = (reason: string) => new ReadAloudHearsayError({ url, reason });
    const socketFailure = (error: Socket.SocketError) => fail(describe(error));

    const socket = yield* Socket.makeWebSocket(`${url.replace(/^http/, "ws")}/v1/speak`, {
      openTimeout: OPEN_TIMEOUT,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    }).pipe(Effect.provide(webSocketConstructor), Effect.mapError(socketFailure));
    // The reader opens the connection; the writer waits for it.
    const reader = yield* socket.reader.pipe(Effect.mapError(socketFailure));
    const writer = yield* socket.writer;
    const send = (message: Record<string, unknown>) =>
      writer.write(JSON.stringify(message)).pipe(Effect.mapError(socketFailure));

    let pending: ReadonlyArray<string | Uint8Array> = [];
    let at = 0;
    const next = Effect.gen(function* () {
      if (at >= pending.length) {
        pending = yield* reader.pull.pipe(Effect.mapError(socketFailure));
        at = 0;
      }
      return pending[at++]!;
    });
    let ended = false;
    /** The next PCM chunk, or undefined once Hearsay says `done`. */
    const nextChunk: Effect.Effect<Uint8Array | undefined, ReadAloudHearsayError> = Effect.gen(
      function* () {
        while (true) {
          const frame = yield* next;
          if (typeof frame !== "string") return frame;
          const message = decodeMessage(frame);
          if (message._tag === "None") continue;
          if (message.value.type === "error") return yield* fail(message.value.message);
          if (message.value.type === "done") {
            ended = true;
            return undefined;
          }
        }
      },
    );
    yield* Effect.addFinalizer(() =>
      ended ? Effect.void : send({ type: "cancel" }).pipe(Effect.ignore),
    );

    yield* Effect.logInfo(
      `read aloud: speaking ${text.length} characters through Hearsay at ${url}`,
    );
    yield* send({ type: "start" });
    for (const piece of pieces(text)) yield* send({ type: "text", text: piece });
    yield* send({ type: "end" });

    const sampleRate = yield* Effect.gen(function* () {
      while (true) {
        const frame = yield* next;
        if (typeof frame !== "string") return yield* fail("audio arrived before its format");
        const message = decodeMessage(frame);
        if (message._tag === "None") continue;
        if (message.value.type === "error") return yield* fail(message.value.message);
        if (message.value.type === "format") return message.value.sample_rate;
        return yield* fail("the speech ended before its format arrived");
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: FORMAT_TIMEOUT,
        orElse: () => Effect.fail(fail(`no speech within ${Duration.format(FORMAT_TIMEOUT)}`)),
      }),
    );

    const audio = Stream.unfold(undefined, () =>
      nextChunk.pipe(
        Effect.timeoutOrElse({
          duration: CHUNK_TIMEOUT,
          orElse: () => Effect.fail(fail(`no speech for ${Duration.format(CHUNK_TIMEOUT)}`)),
        }),
        Effect.map((chunk) => (chunk === undefined ? undefined : ([chunk, undefined] as const))),
      ),
    );
    return { sampleRate, audio } satisfies Utterance;
  });

  const speakReply = Effect.fn("ReadAloudService.speakReply")(function* (
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    const notFound = new ReadAloudReplyNotFoundError({ threadId, messageId });
    // A reply shown in a forked thread may live in the thread it was forked from.
    let message: OrchestrationV2ConversationMessage | undefined;
    let current = threadId;
    for (let hop = 0; hop <= MAX_FORK_HOPS && message === undefined; hop += 1) {
      const found = yield* projections
        .getMessagesById(current, [messageId])
        .pipe(
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.fail(notFound) }),
        );
      message = found.get(messageId);
      if (message !== undefined) break;
      const thread = yield* projections
        .getThread(current)
        .pipe(
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.fail(notFound) }),
        );
      if (thread.forkedFrom?.type !== "run") break;
      current = thread.forkedFrom.threadId;
    }
    if (message === undefined || message.role !== "assistant") return yield* notFound;
    if (message.streaming) return yield* new ReadAloudReplyStreamingError({ messageId });
    const text = speakableText(message.text);
    if (!text) return yield* new ReadAloudNothingToReadError({ messageId });
    return yield* speak(text);
  });

  return ReadAloudService.of({ speak, speakReply });
});

export const layer = Layer.effect(ReadAloudService, make);
