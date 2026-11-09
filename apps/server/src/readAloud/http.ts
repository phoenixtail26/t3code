// Fork feature: read aloud. One raw route streams a reply's speech as PCM, the whole reply
// or a spoken summary of it; a chunked binary body does not belong in the JSON API or on
// the WebSocket. Mounted inside the fork's dictation route layer.
import { AuthOrchestrationOperateScope, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as ReadAloudService from "./ReadAloudService.ts";

export const READ_ALOUD_SPEAK_PATH = "/api/read-aloud/speak";
/** The PCM's sample rate, on the response; the body is mono Int16 little-endian. */
export const READ_ALOUD_SAMPLE_RATE_HEADER = "read-aloud-sample-rate";

const SpeakRequest = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  /** `full` speaks the reply's words; `summary` a few sentences about it. */
  mode: Schema.optional(Schema.Literals(["full", "summary"])),
});
const decodeSpeakRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(SpeakRequest));

// The same check as the fork's dictation routes, so the desktop and the phone reach it alike.
const authenticate = Effect.fn("readAloud.authenticate")(function* () {
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
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
  }
});

const authErrors = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

const errorResponse = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status });

const failure = (status: number) => (error: { readonly message: string }) =>
  Effect.succeed(errorResponse(status, error.message));

/** The route alone; tests give it a service on a fake projection store. */
export const readAloudRoutes = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const readAloud = yield* ReadAloudService.ReadAloudService;

    yield* router.add(
      "POST",
      READ_ALOUD_SPEAK_PATH,
      Effect.gen(function* () {
        yield* authenticate();
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* request.text.pipe(Effect.flatMap(decodeSpeakRequest), Effect.option);
        if (input._tag === "None")
          return errorResponse(400, "The request must name a thread and a message.");
        const { threadId, messageId, mode } = input.value;
        const utterance =
          mode === "summary"
            ? yield* readAloud.speakSummary(threadId, messageId)
            : yield* readAloud.speakReply(threadId, messageId);
        return HttpServerResponse.stream(
          utterance.audio.pipe(
            Stream.tapError((error) => Effect.logWarning(`read aloud: ${error.message}`)),
          ),
          {
            contentType: "application/octet-stream",
            // no-transform keeps the global compression middleware from buffering the stream.
            headers: {
              "cache-control": "no-store, no-transform",
              "x-accel-buffering": "no",
              [READ_ALOUD_SAMPLE_RATE_HEADER]: String(utterance.sampleRate),
            },
          },
        );
      }).pipe(
        Effect.tapError((error) =>
          "message" in error ? Effect.logWarning(`read aloud: ${error.message}`) : Effect.void,
        ),
        Effect.catchTags({
          ...authErrors,
          ReadAloudReplyNotFoundError: failure(404),
          ReadAloudReplyStreamingError: failure(409),
          ReadAloudNothingToReadError: failure(409),
          ReadAloudNotConfiguredError: failure(409),
          ReadAloudHearsayError: failure(502),
          ReadAloudSummaryError: failure(502),
          ProjectionStoreSetupError: failure(500),
          ProjectionStoreApplyEventError: failure(500),
          ProjectionStoreReadError: failure(500),
        }),
      ),
    );
  }),
);

export const layerReadAloudRoutes = readAloudRoutes.pipe(
  Layer.provide(ReadAloudService.layer.pipe(Layer.provide(ProjectionStoreV2.layer))),
);
