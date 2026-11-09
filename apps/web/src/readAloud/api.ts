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

/** Mirrors `apps/server/src/readAloud/http.ts`. */
const READ_ALOUD_SPEAK_PATH = "/api/read-aloud/speak";
const SAMPLE_RATE_HEADER = "read-aloud-sample-rate";
// Long enough for the longest reply; stopping ends the request sooner.
const SPEAK_TIMEOUT_MS = 30 * 60_000;

export interface SpeakRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  /** Called once with the PCM's sample rate, before the first chunk. */
  readonly onFormat: (sampleRate: number) => void;
  readonly onChunk: (pcm: Uint8Array) => void;
  /** Resolving it ends the request, which cancels the utterance on the server. */
  readonly stop: Promise<void>;
}

export type SpeakResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

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
        // The scope owns the fetch; stopping closes it and the server cancels the utterance.
        const client = HttpClient.withScope(yield* HttpClient.HttpClient);
        const request = HttpClientRequest.post(requestUrl).pipe(
          HttpClientRequest.setHeaders({ ...headers }),
          HttpClientRequest.bodyJsonUnsafe({
            threadId: input.threadId,
            messageId: input.messageId,
          }),
        );
        const response = yield* client.execute(request);
        if (response.status < 200 || response.status >= 300) {
          return { status: response.status, body: yield* response.text };
        }
        input.onFormat(Number(response.headers[SAMPLE_RATE_HEADER]));
        yield* Stream.runForEach(response.stream, (chunk) =>
          Effect.sync(() => input.onChunk(chunk)),
        ).pipe(Effect.raceFirst(Effect.promise(() => input.stop)));
        return { status: response.status, body: "" };
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
