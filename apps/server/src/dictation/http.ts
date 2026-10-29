// Fork feature: raw HTTP routes for dictation. The audio is a raw PCM body of
// up to 9.6 MB, which does not belong on the WebSocket or in a JSON API.
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  DICTATION_MAX_AUDIO_BYTES,
  DICTATION_MODEL_PATH,
  DICTATION_STATUS_PATH,
  DICTATION_TRANSCRIBE_PATH,
  type DictationErrorResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as DictationService from "./DictationService.ts";
import * as DictationWorker from "./worker.ts";

const authenticate = Effect.fn("dictation.authenticate")(function* (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
});

const errorResponse = (status: number, error: { readonly message: string }) =>
  HttpServerResponse.jsonUnsafe({ error: error.message } satisfies DictationErrorResponse, {
    status,
  });

const tooLarge = errorResponse(413, { message: "Recordings are limited to five minutes." });

const authErrors = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

const failure = (status: number) => (error: { readonly message: string }) =>
  Effect.succeed(errorResponse(status, error));

/** Reads the body, or returns null once it passes the five-minute cap. */
const readCappedBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const declared = Number(request.headers["content-length"] ?? Number.NaN);
  if (declared > DICTATION_MAX_AUDIO_BYTES) return null;
  const chunks: Array<Uint8Array> = [];
  let received = 0;
  yield* request.stream.pipe(
    Stream.takeWhile((chunk) => {
      received += chunk.byteLength;
      return received <= DICTATION_MAX_AUDIO_BYTES;
    }),
    Stream.runForEach((chunk) => Effect.sync(() => chunks.push(chunk))),
  );
  if (received > DICTATION_MAX_AUDIO_BYTES) return null;
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
});

// The service is resolved once when the routes are registered, so handlers
// only need the per-request auth context.
export const layerDictationRoutes = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const dictation = yield* DictationService.DictationService;

    yield* router.add(
      "POST",
      DICTATION_TRANSCRIBE_PATH,
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        const body = yield* readCappedBody.pipe(Effect.orElseSucceed(() => undefined));
        if (body === null) return tooLarge;
        if (body === undefined) {
          return errorResponse(400, { message: "The recording could not be read." });
        }
        return HttpServerResponse.jsonUnsafe(yield* dictation.transcribe(body));
      }).pipe(
        Effect.catchTags({
          ...authErrors,
          DictationInvalidAudioError: failure(400),
          DictationModelDownloadError: failure(502),
          DictationWorkerError: failure(500),
        }),
      ),
    );

    yield* router.add(
      "GET",
      DICTATION_STATUS_PATH,
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        return HttpServerResponse.jsonUnsafe(yield* dictation.status);
      }).pipe(Effect.catchTags(authErrors)),
    );

    yield* router.add(
      "POST",
      DICTATION_MODEL_PATH,
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        yield* dictation.downloadModel;
        return HttpServerResponse.empty({ status: 204 });
      }).pipe(Effect.catchTags({ ...authErrors, DictationModelDownloadError: failure(502) })),
    );

    yield* router.add(
      "DELETE",
      DICTATION_MODEL_PATH,
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        yield* dictation.removeModel;
        return HttpServerResponse.empty({ status: 204 });
      }).pipe(Effect.catchTags({ ...authErrors, DictationModelRemoveError: failure(500) })),
    );
  }),
).pipe(Layer.provide(DictationService.layer), Layer.provide(DictationWorker.layer));
