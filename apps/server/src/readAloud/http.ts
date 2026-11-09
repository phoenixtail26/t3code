// Fork feature: read aloud. One raw route streams a reply's speech as PCM; a chunked
// binary body does not belong in the JSON API or on the WebSocket. Mounted inside the
// fork's dictation route layer.
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
import { speakableText } from "./speakableText.ts";

export const READ_ALOUD_SPEAK_PATH = "/api/read-aloud/speak";
/** The PCM's sample rate, on the response; the body is mono Int16 little-endian. */
export const READ_ALOUD_SAMPLE_RATE_HEADER = "read-aloud-sample-rate";

const SpeakRequest = Schema.Struct({ threadId: ThreadId, messageId: MessageId });
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

/** The route alone; tests give it a fake projection store. */
export const readAloudRoutes = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const readAloud = yield* ReadAloudService.ReadAloudService;
    const projections = yield* ProjectionStoreV2.ProjectionStoreV2;

    yield* router.add(
      "POST",
      READ_ALOUD_SPEAK_PATH,
      Effect.gen(function* () {
        yield* authenticate();
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* request.text.pipe(Effect.flatMap(decodeSpeakRequest), Effect.option);
        if (input._tag === "None")
          return errorResponse(400, "The request must name a thread and a message.");
        const projection = yield* projections.getThreadProjection(input.value.threadId).pipe(
          Effect.catchTags({
            ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
          }),
        );
        const message = projection?.messages.find(
          (candidate) => candidate.id === input.value.messageId && candidate.role === "assistant",
        );
        if (!message) return errorResponse(404, "There is no such reply in this thread.");
        if (message.streaming) return errorResponse(409, "This reply is still being written.");
        const text = speakableText(message.text);
        if (!text) return errorResponse(409, "There is nothing to read in this reply.");
        const utterance = yield* readAloud.speak(text);
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
          ReadAloudNotConfiguredError: failure(409),
          ReadAloudHearsayError: failure(502),
          ProjectionStoreSetupError: failure(500),
          ProjectionStoreApplyEventError: failure(500),
          ProjectionStoreReadError: failure(500),
        }),
      ),
    );
  }),
);

export const layerReadAloudRoutes = readAloudRoutes.pipe(
  Layer.provide(ReadAloudService.layer),
  Layer.provide(ProjectionStoreV2.layer),
);
