// Fork feature: dictation. HTTP calls to the environment's dictation routes,
// authenticated the same way as every other environment HTTP request
// (session cookie on the primary origin, bearer or DPoP elsewhere).
import {
  DICTATION_MODEL_PATH,
  DICTATION_STATUS_PATH,
  DICTATION_TRANSCRIBE_PATH,
  DictationStatus,
  DictationTranscript,
  type EnvironmentId,
} from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { executeAuthenticatedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environment-http-auth";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpMethod } from "effect/http";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "../state/session";

export type DictationResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

/** What the controller needs from the server; swapped for a fake in tests. */
export interface DictationApi {
  status(environmentId: EnvironmentId): Promise<DictationResult<DictationStatus>>;
  /** Starts or joins the model download and resolves when it is complete. */
  downloadModel(environmentId: EnvironmentId): Promise<DictationResult<void>>;
  /** Cancels any download, unloads the model and deletes the file. */
  removeModel(environmentId: EnvironmentId): Promise<DictationResult<void>>;
  transcribe(
    environmentId: EnvironmentId,
    pcm: Uint8Array,
  ): Promise<DictationResult<DictationTranscript>>;
}

class DictationEnvironmentOfflineError extends Data.TaggedError(
  "DictationEnvironmentOfflineError",
)<{
  readonly message: string;
}> {}

const STATUS_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 2 * 60_000;

interface DictationRequest {
  readonly environmentId: EnvironmentId;
  readonly method: HttpMethod.HttpMethod;
  readonly path: string;
  readonly body?: Uint8Array;
  readonly timeoutMs: number;
}

interface RawResponse {
  readonly status: number;
  readonly text: string;
}

// `executeAuthenticatedEnvironmentHttpRequest` signs the URL its group builder
// returns, so the dictation URL is derived from the auth group's base and
// remembered for the request callback, which is invoked right after.
const dictationRequest = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:dictation:request",
  execute: Effect.fn("dictationRequest")(function* (input: DictationRequest) {
    const prepared = readPreparedConnection(input.environmentId);
    if (prepared === null) {
      return yield* new DictationEnvironmentOfflineError({
        message: "The environment is not connected.",
      });
    }
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    let requestUrl = "";
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      group: "auth",
      method: input.method,
      url: (urls) => {
        requestUrl = new URL(input.path, urls.session()).toString();
        return requestUrl;
      },
      timeoutMs: input.timeoutMs,
      request: Effect.fn("dictationRequest.request")(function* ({ headers }) {
        const client = yield* HttpClient.HttpClient;
        let request = HttpClientRequest.make(input.method)(requestUrl).pipe(
          HttpClientRequest.setHeaders({ ...headers }),
        );
        if (input.body !== undefined) {
          request = HttpClientRequest.bodyUint8Array(
            request,
            input.body,
            "application/octet-stream",
          );
        }
        const response = yield* client.execute(request);
        const text = yield* response.text;
        return { status: response.status, text } satisfies RawResponse;
      }),
    });
  }),
});

const decodeStatus = Schema.decodeUnknownSync(Schema.fromJsonString(DictationStatus));
const decodeTranscript = Schema.decodeUnknownSync(Schema.fromJsonString(DictationTranscript));

/** The route's `{ error }` body when it has one, else a status line. */
function errorFromResponse(response: RawResponse): string {
  try {
    const parsed: unknown = JSON.parse(response.text);
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
  return `The server answered with status ${response.status}.`;
}

function describeFailure(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error ? squashed.message : String(squashed);
}

async function send<A>(
  input: DictationRequest,
  decode: (response: RawResponse) => A,
): Promise<DictationResult<A>> {
  const result = await dictationRequest.run(appAtomRegistry, input);
  if (!AsyncResult.isSuccess(result)) {
    return { ok: false, error: describeFailure(result.cause) };
  }
  const response = result.value;
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: errorFromResponse(response) };
  }
  try {
    return { ok: true, value: decode(response) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const dictationApi: DictationApi = {
  status: (environmentId) =>
    send(
      { environmentId, method: "GET", path: DICTATION_STATUS_PATH, timeoutMs: STATUS_TIMEOUT_MS },
      (response) => decodeStatus(response.text),
    ),
  downloadModel: (environmentId) =>
    send(
      {
        environmentId,
        method: "POST",
        path: DICTATION_MODEL_PATH,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      },
      () => undefined,
    ),
  removeModel: (environmentId) =>
    send(
      {
        environmentId,
        method: "DELETE",
        path: DICTATION_MODEL_PATH,
        timeoutMs: STATUS_TIMEOUT_MS,
      },
      () => undefined,
    ),
  transcribe: (environmentId, pcm) =>
    send(
      {
        environmentId,
        method: "POST",
        path: DICTATION_TRANSCRIBE_PATH,
        body: pcm,
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      },
      (response) => decodeTranscript(response.text),
    ),
};
