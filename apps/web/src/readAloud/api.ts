// Fork feature: read aloud. The speech route, called with the same credentials as every
// other environment HTTP request (session cookie on the primary origin, bearer or DPoP
// elsewhere), so the desktop and the phone reach it alike. The PCM arrives chunk by chunk.
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { executeAuthenticatedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environment-http-auth";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "../state/session";
import { createUtteranceReader, type ReadAloudStreamError } from "./stream";

/** Mirrors `apps/server/src/readAloud/http.ts`. */
const READ_ALOUD_SPEAK_PATH = "/api/read-aloud/speak";
/** Readable only on the server's own origin; the body carries the rate for every other page. */
const SAMPLE_RATE_HEADER = "read-aloud-sample-rate";
// Long enough for the longest reply; stopping ends the request sooner.
const SPEAK_TIMEOUT_MS = 30 * 60_000;

export interface SpeakRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly mode?: "full" | "summary";
  /** Called once with the PCM's sample rate, before the first chunk. */
  readonly onFormat: (sampleRate: number) => void;
  readonly onChunk: (pcm: Uint8Array) => void;
  /** Resolving it ends the request, which cancels the utterance on the server. */
  readonly stop: Promise<void>;
}

export type SpeakResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** The request ended because the person stopped; there is no answer to read. */
const STOPPED = { status: 200, body: "" } as const;

class ReadAloudEnvironmentOfflineError extends Schema.TaggedError<
  ReadAloudEnvironmentOfflineError,
  { readonly brand: unique symbol }
>()("ReadAloudEnvironmentOfflineError", { message: Schema.String }) {}

const speakCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:read-aloud:speak",
  execute: Effect.fn("readAloud.speak")(function* (input: SpeakRequest) {
    const prepared = readPreparedConnection(input.environmentId);
    if (prepared === null) {
      return yield* new ReadAloudEnvironmentOfflineError({
        message: "The environment is not connected.",
      });
    }
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    let requestUrl = "";
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      group: "auth",
      method: "POST",
      url: (urls) => {
        requestUrl = new URL(READ_ALOUD_SPEAK_PATH, urls.session()).toString();
        return requestUrl;
      },
      timeoutMs: SPEAK_TIMEOUT_MS,
      request: Effect.fn("readAloud.speak.request")(function* ({ headers }) {
        // The scope owns the fetch; stopping closes it, headers pending or not, so the fetch
        // aborts and the server cancels the utterance on Hearsay's socket.
        const client = HttpClient.withScope(yield* HttpClient.HttpClient);
        const request = HttpClientRequest.post(requestUrl).pipe(
          HttpClientRequest.setHeaders({ ...headers }),
          HttpClientRequest.bodyJsonUnsafe({
            threadId: input.threadId,
            messageId: input.messageId,
            ...(input.mode ? { mode: input.mode } : {}),
          }),
        );
        const exchange = Effect.gen(function* () {
          const response = yield* client.execute(request);
          if (response.status < 200 || response.status >= 300) {
            return { status: response.status, body: yield* response.text };
          }
          const reader = createUtteranceReader(response.headers[SAMPLE_RATE_HEADER], input);
          const fed = (failure: ReadAloudStreamError | null) =>
            failure === null ? Effect.void : Effect.fail(failure);
          yield* Stream.runForEach(response.stream, (chunk) => fed(reader.push(chunk)));
          yield* fed(reader.end());
          return { status: response.status, body: "" };
        });
        return yield* Effect.raceFirst(
          exchange,
          Effect.promise(() => input.stop).pipe(Effect.as(STOPPED)),
        );
      }, Effect.scoped),
    });
  }),
});

/** The route's `{ error }` sentence when it has one, else a status line. */
function errorFromBody(status: number, body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string"
    ) {
      return parsed.error;
    }
  } catch {
    // Not JSON: fall through to the status line.
  }
  return `The server answered with status ${status}.`;
}

export async function speak(input: SpeakRequest): Promise<SpeakResult> {
  const result = await speakCommand.run(appAtomRegistry, input);
  if (!AsyncResult.isSuccess(result)) {
    const squashed = Cause.squash(result.cause);
    return { ok: false, error: squashed instanceof Error ? squashed.message : String(squashed) };
  }
  const { status, body } = result.value;
  if (status < 200 || status >= 300) return { ok: false, error: errorFromBody(status, body) };
  return { ok: true };
}

/** Mirrors `apps/server/src/readAloud/http.ts`. */
const READ_ALOUD_DICTATED_PATH = "/api/read-aloud/dictated";
// The server gives Hearsay three seconds; the rest covers the hop to a remote environment.
const DICTATED_TIMEOUT_MS = 10_000;

export interface DictatedRequest {
  readonly environmentId: EnvironmentId;
  /** The message as sent; the server compares it with Hearsay's history and keeps it. */
  readonly text: string;
}

const DictatedAnswer = Schema.Struct({ dictated: Schema.Boolean });
const decodeDictatedAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(DictatedAnswer));

const dictatedCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:read-aloud:dictated",
  execute: Effect.fn("readAloud.dictated")(function* (input: DictatedRequest) {
    const prepared = readPreparedConnection(input.environmentId);
    if (prepared === null) return false;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    let requestUrl = "";
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      group: "auth",
      method: "POST",
      url: (urls) => {
        requestUrl = new URL(READ_ALOUD_DICTATED_PATH, urls.session()).toString();
        return requestUrl;
      },
      timeoutMs: DICTATED_TIMEOUT_MS,
      request: Effect.fn("readAloud.dictated.request")(function* ({ headers }) {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(
          HttpClientRequest.post(requestUrl).pipe(
            HttpClientRequest.setHeaders({ ...headers }),
            HttpClientRequest.bodyJsonUnsafe({ text: input.text }),
          ),
        );
        if (response.status !== 200) return false;
        const answer = decodeDictatedAnswer(yield* response.text);
        return answer._tag === "Some" && answer.value.dictated;
      }),
    });
  }),
});

/**
 * Whether the server finds `text` among Hearsay's recent hotkey dictations. False whenever
 * the answer cannot be had: the composer never sees an error from this.
 */
export async function wasDictated(input: DictatedRequest): Promise<boolean> {
  try {
    const result = await dictatedCommand.run(appAtomRegistry, input);
    return AsyncResult.isSuccess(result) && result.value;
  } catch {
    return false;
  }
}
