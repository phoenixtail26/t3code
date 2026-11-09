// Fork feature: Hearsay behind upstream's SpeechService, mounted by server.ts in place
// of upstream's layer. With `hearsaySpeech.url` empty every call hands through; with it
// set, audio goes to Hearsay as Int16 PCM and upstream's engine, hints and cleanup never run.
import {
  SPEECH_STREAM_MAX_CHUNK_BYTES,
  type EnvironmentSpeechModel,
  type EnvironmentSpeechModels,
  type EnvironmentSpeechStatus,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import * as Upstream from "./SpeechService.ts";

/** Hearsay's batch recogniser, the one model the status and model list describe. */
export const HEARSAY_RECOGNIZER_MODEL_ID = "parakeet-tdt-0.6b-v2-int8";
/** Five minutes of 16 kHz mono Int16 PCM, Hearsay's `POST /v1/transcribe` limit. */
export const HEARSAY_MAX_PCM_BYTES = 9_600_000;
const HEARSAY_MODEL_NAME = "Parakeet TDT 0.6B v2 (Hearsay)";
const STATUS_TIMEOUT = Duration.seconds(10);
// Covers a five-minute clip and a cold model load. The socket client stops waiting after
// two minutes without an event, so a model download belongs to the Download action.
const TRANSCRIBE_TIMEOUT = Duration.minutes(10);
const DOWNLOAD_POLL = Duration.seconds(1);

/** A plain failure the owner can read, kept a SpeechOperationError for upstream's error mapping. */
export class HearsaySpeechError extends Upstream.SpeechOperationError {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : super.message;
  }
}

/** Float32 samples clipped to [-1, 1] as little-endian Int16 PCM. */
export function float32ToInt16Pcm(pcm: Float32Array): Uint8Array {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index]!));
    view.setInt16(index * 2, Math.round(sample * 32767), true);
  }
  return bytes;
}

const HearsayTranscript = Schema.Struct({ text: Schema.String });
const HearsayModelState = Schema.Struct({
  state: Schema.Literals(["missing", "downloading", "ready"]),
  percent: Schema.optionalKey(Schema.Number),
  size_bytes: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.String),
});
const HearsayStatus = Schema.Struct({
  models: Schema.Record(Schema.String, HearsayModelState),
  failures: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  unavailable: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
type HearsayStatus = typeof HearsayStatus.Type;
const HearsayErrorBody = Schema.Struct({ error: Schema.String });
const decodeTranscript = Schema.decodeUnknownEffect(Schema.fromJsonString(HearsayTranscript));
const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(HearsayStatus));
const isInvalidAudio = Schema.is(Upstream.SpeechInvalidAudioError);
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(HearsayErrorBody));

type Settings = Effect.Success<ServerSettings.ServerSettingsService["Service"]["getSettings"]>;
type Target = { readonly url: string; readonly token: string; readonly settings: Settings };

// A refused connection surfaces as "fetch failed"; the reason is at the end of the cause chain.
const describe = (cause: unknown): string => {
  let current = cause;
  while (current instanceof Error && current.cause instanceof Error) current = current.cause;
  if (!(current instanceof Error)) return String(current);
  return current.message || ("code" in current ? String(current.code) : current.name);
};

const make = Effect.gen(function* () {
  const upstream = yield* Upstream.SpeechService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const http = yield* HttpClient.HttpClient;
  let activeTranscriptions = 0;

  const target = (operation: string) =>
    serverSettings.getSettings.pipe(
      Effect.mapError((cause) => new Upstream.SpeechOperationError({ operation, cause })),
      Effect.map((settings): Target | undefined =>
        settings.hearsaySpeech.url
          ? {
              url: settings.hearsaySpeech.url.replace(/\/+$/, ""),
              token: settings.hearsaySpeech.token,
              settings,
            }
          : undefined,
      ),
    );

  const dispatch = <A, E, R>(
    operation: string,
    passThrough: Effect.Effect<A, E, R>,
    forward: (target: Target) => Effect.Effect<A, E | Upstream.SpeechError, R>,
  ) =>
    target(operation).pipe(Effect.flatMap((hearsay) => (hearsay ? forward(hearsay) : passThrough)));

  const fail = (operation: string, hearsay: Target, reason: string) =>
    new HearsaySpeechError({
      operation,
      cause: new Error(`Hearsay at ${hearsay.url} did not answer: ${reason}`),
    });

  const decodePcm = (operation: string, bytes: Uint8Array) =>
    Effect.try({
      try: () => Upstream.decodeSpeechPcm(bytes),
      catch: (cause) =>
        isInvalidAudio(cause) ? cause : new Upstream.SpeechOperationError({ operation, cause }),
    });

  /** One Hearsay request: status checked, body read, all within `timeout`. */
  const call = Effect.fn("HearsaySpeechService.call")(function* (
    hearsay: Target,
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    timeout: Duration.Duration,
  ) {
    const authorized = hearsay.token
      ? HttpClientRequest.bearerToken(request, Redacted.make(hearsay.token))
      : request;
    return yield* Effect.gen(function* () {
      const response = yield* http.execute(authorized).pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError((cause) => fail(operation, hearsay, describe(cause))),
      );
      const body = yield* response.text.pipe(
        Effect.mapError((cause) => fail(operation, hearsay, describe(cause))),
      );
      if (response.status < 200 || response.status >= 300) {
        const reason = decodeErrorBody(body).pipe((decoded) =>
          decoded._tag === "Some" ? decoded.value.error : undefined,
        );
        return yield* fail(operation, hearsay, reason ?? `HTTP ${response.status}`);
      }
      return { body, headers: response.headers };
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(fail(operation, hearsay, `no answer within ${Duration.format(timeout)}`)),
      }),
    );
  });

  const malformed = (operation: string, hearsay: Target) => (cause: unknown) =>
    fail(operation, hearsay, `unexpected answer: ${describe(cause)}`);

  const fetchStatus = Effect.fn("HearsaySpeechService.status")(function* (
    hearsay: Target,
    operation: string,
  ) {
    const { body } = yield* call(
      hearsay,
      operation,
      HttpClientRequest.get(`${hearsay.url}/v1/status`),
      STATUS_TIMEOUT,
    );
    return yield* decodeStatus(body).pipe(Effect.mapError(malformed(operation, hearsay)));
  });

  // Hearsay builds before its model-name keys report the recogniser under its engine name.
  const recognizer = (status: HearsayStatus) =>
    status.models[HEARSAY_RECOGNIZER_MODEL_ID] ?? status.models.recognizer;

  const toStatus = (hearsay: Target, status: HearsayStatus): EnvironmentSpeechStatus => {
    const failure = status.unavailable.recognizer ?? status.failures.recognizer;
    if (failure) return { supported: false, reason: `Hearsay at ${hearsay.url}: ${failure}` };
    const model = recognizer(status);
    if (!model)
      return {
        supported: false,
        reason: `Hearsay at ${hearsay.url} does not list ${HEARSAY_RECOGNIZER_MODEL_ID}`,
      };
    return {
      supported: true,
      state:
        model.state !== "ready"
          ? "missing-model"
          : activeTranscriptions > 0
            ? "transcribing"
            : "ready",
      modelId: HEARSAY_RECOGNIZER_MODEL_ID,
      model: HEARSAY_MODEL_NAME,
      size: model.size_bytes ?? 0,
      // Hearsay transcribes the whole recording at finish; the socket path buffers it.
      supportsStreaming: false,
      supportsBufferedStreaming: true,
      supportsTranslation: false,
      languages: ["en"],
      supportsLanguageDetection: false,
      acceleration: hearsay.settings.speechAcceleration,
      modelUnloadTimeout: hearsay.settings.speechModelUnloadTimeout,
      gpuDevices: [],
    };
  };

  const toModels = (hearsay: Target, status: HearsayStatus): EnvironmentSpeechModels => {
    const model = recognizer(status);
    if (!model) return { models: [] };
    const size = model.size_bytes ?? 0;
    const entry: EnvironmentSpeechModel = {
      id: HEARSAY_RECOGNIZER_MODEL_ID,
      name: HEARSAY_MODEL_NAME,
      description: `Hearsay's recogniser at ${hearsay.url}. Its dictionary and cleanup are set in Hearsay's settings window.`,
      size,
      languages: ["en"],
      accuracy: 0,
      speed: 0,
      recommended: true,
      supportsStreaming: false,
      supportsLanguageDetection: false,
      supportsTranslation: false,
      active: model.state === "ready",
      state:
        model.state === "ready"
          ? "installed"
          : model.state === "downloading"
            ? "downloading"
            : "downloadable",
      ...(model.state === "downloading"
        ? { downloaded: Math.round(((model.percent ?? 0) / 100) * size) }
        : {}),
    };
    return { models: [entry] };
  };

  const models = (hearsay: Target, operation: string) =>
    fetchStatus(hearsay, operation).pipe(Effect.map((status) => toModels(hearsay, status)));

  const requireHearsayModel = (modelId: string) =>
    modelId === HEARSAY_RECOGNIZER_MODEL_ID
      ? Effect.void
      : Effect.fail(new Upstream.SpeechModelNotFoundError({ modelId }));

  /** Hearsay answers the download request at once; the client expects the call to return once the model landed. */
  const download = Effect.fn("HearsaySpeechService.download")(function* (
    hearsay: Target,
    modelId: string,
  ) {
    const operation = "model download";
    yield* requireHearsayModel(modelId);
    const started = yield* call(
      hearsay,
      operation,
      HttpClientRequest.post(`${hearsay.url}/v1/models/${modelId}/download`),
      STATUS_TIMEOUT,
    );
    let status = yield* decodeStatus(started.body).pipe(
      Effect.mapError(malformed(operation, hearsay)),
    );
    while (recognizer(status)?.state === "downloading") {
      yield* Effect.sleep(DOWNLOAD_POLL);
      status = yield* fetchStatus(hearsay, operation);
    }
    const model = recognizer(status);
    if (model?.state === "missing" && model.error)
      return yield* fail(operation, hearsay, model.error);
    return toModels(hearsay, status);
  });

  const remove = Effect.fn("HearsaySpeechService.remove")(function* (
    hearsay: Target,
    operation: string,
  ) {
    const { body } = yield* call(
      hearsay,
      operation,
      HttpClientRequest.delete(`${hearsay.url}/v1/models/${HEARSAY_RECOGNIZER_MODEL_ID}`),
      STATUS_TIMEOUT,
    );
    const status = yield* decodeStatus(body).pipe(Effect.mapError(malformed(operation, hearsay)));
    return toModels(hearsay, status);
  });

  const transcribe = Effect.fn("HearsaySpeechService.transcribe")(function* (
    hearsay: Target,
    operation: string,
    pcmBytes: Uint8Array,
  ) {
    if (pcmBytes.byteLength / 2 > HEARSAY_MAX_PCM_BYTES) {
      const message = `Hearsay at ${hearsay.url} refused the recording: it is longer than five minutes`;
      yield* Effect.logWarning(message);
      return yield* new Upstream.SpeechInvalidAudioError({
        byteLength: pcmBytes.byteLength,
        message,
      });
    }
    const pcm = yield* decodePcm(operation, pcmBytes);
    if (pcm.length === 0) return "";
    activeTranscriptions += 1;
    return yield* Effect.gen(function* () {
      const { body, headers } = yield* call(
        hearsay,
        operation,
        HttpClientRequest.post(`${hearsay.url}/v1/transcribe`).pipe(
          HttpClientRequest.setUrlParam("source", "t3code"),
          HttpClientRequest.bodyUint8Array(float32ToInt16Pcm(pcm), "application/octet-stream"),
        ),
        TRANSCRIBE_TIMEOUT,
      );
      const transcript = yield* decodeTranscript(body).pipe(
        Effect.mapError(malformed(operation, hearsay)),
      );
      yield* Effect.logInfo(
        `speech: forwarded to Hearsay at ${hearsay.url}, entry ${headers["hearsay-entry"] ?? "unknown"}`,
      );
      return transcript.text;
    }).pipe(
      Effect.tapError((error) => Effect.logWarning(error.message)),
      Effect.ensuring(
        Effect.sync(() => {
          activeTranscriptions -= 1;
        }),
      ),
    );
  });

  /** Chunks are acknowledged without text and transcribed together at finish. */
  const stream = (hearsay: Target): Effect.Effect<Upstream.SpeechStream, never, Scope.Scope> =>
    Effect.sync(() => {
      const operation = "streaming transcription";
      const received: Uint8Array[] = [];
      let byteLength = 0;
      let revision = 0;
      let finished = false;
      const notReady = () =>
        new Upstream.SpeechOperationError({
          operation,
          cause: new Error("Speech stream is not ready."),
        });
      return {
        feed: (bytes) =>
          Effect.suspend(() => {
            if (finished) return Effect.fail(notReady());
            if (
              bytes.byteLength > SPEECH_STREAM_MAX_CHUNK_BYTES ||
              byteLength + bytes.byteLength > Upstream.MAX_SPEECH_BYTES
            )
              return Effect.fail(
                new Upstream.SpeechInvalidAudioError({
                  byteLength: bytes.byteLength,
                  message: "Speech stream audio limit exceeded.",
                }),
              );
            return decodePcm(operation, bytes).pipe(
              Effect.map(() => {
                received.push(Uint8Array.from(bytes));
                byteLength += bytes.byteLength;
                revision += 1;
                return { revision, text: null };
              }),
            );
          }),
        finish: Effect.suspend(() => {
          if (finished) return Effect.fail(notReady());
          finished = true;
          const all = new Uint8Array(byteLength);
          let offset = 0;
          for (const chunk of received) {
            all.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return transcribe(hearsay, operation, all);
        }),
      };
    });

  // An unreachable Hearsay is reported as unsupported so the client shows the reason.
  const status = (operation: string, hearsay: Target) =>
    fetchStatus(hearsay, operation).pipe(
      Effect.map((current) => toStatus(hearsay, current)),
      Effect.catch((error) =>
        Effect.succeed<EnvironmentSpeechStatus>({ supported: false, reason: error.message }),
      ),
    );

  // Upstream's own updates read its status, which starts its GPU discovery worker.
  const saveSetting = (
    hearsay: Target,
    operation: string,
    patch: Parameters<typeof serverSettings.updateSettings>[0],
  ) =>
    serverSettings.updateSettings(patch).pipe(
      Effect.mapError((cause) => new Upstream.SpeechOperationError({ operation, cause })),
      Effect.flatMap((settings) => status(operation, { ...hearsay, settings })),
    );

  // Untraced: upstream's methods and the Hearsay operations above open their own spans.
  const route = <Args extends ReadonlyArray<unknown>, A, E, R>(
    operation: string,
    passThrough: (...args: Args) => Effect.Effect<A, E, R>,
    forward: (hearsay: Target, ...args: Args) => Effect.Effect<A, E | Upstream.SpeechError, R>,
  ) =>
    Effect.fnUntraced(function* (...args: Args) {
      const hearsay = yield* target(operation);
      return yield* hearsay ? forward(hearsay, ...args) : passThrough(...args);
    });

  return Upstream.SpeechService.of({
    status: dispatch("status", upstream.status, (hearsay) => status("status", hearsay)),
    models: route("model listing", upstream.models, (hearsay) => models(hearsay, "model listing")),
    downloadModel: route("model download", upstream.downloadModel, download),
    selectModel: route("model selection", upstream.selectModel, (hearsay, modelId) =>
      requireHearsayModel(modelId).pipe(Effect.andThen(models(hearsay, "model selection"))),
    ),
    cancelDownload: route("model download", upstream.cancelDownload, (hearsay, modelId) =>
      modelId === HEARSAY_RECOGNIZER_MODEL_ID
        ? remove(hearsay, "model download")
        : models(hearsay, "model download"),
    ),
    removeModel: route("model removal", upstream.removeModel, (hearsay, modelId) =>
      requireHearsayModel(modelId).pipe(Effect.andThen(remove(hearsay, "model removal"))),
    ),
    prepareModel: dispatch("model preparation", upstream.prepareModel, () => Effect.void),
    transcribe: route("transcription", upstream.transcribe, (hearsay, pcmBytes) =>
      transcribe(hearsay, "transcription", pcmBytes),
    ),
    startStream: route("streaming transcription", upstream.startStream, stream),
    updateAcceleration: route(
      "acceleration update",
      upstream.updateAcceleration,
      (hearsay, speechAcceleration) =>
        saveSetting(hearsay, "acceleration update", { speechAcceleration }),
    ),
    updateModelUnloadTimeout: route(
      "model unload timeout update",
      upstream.updateModelUnloadTimeout,
      (hearsay, speechModelUnloadTimeout) =>
        saveSetting(hearsay, "model unload timeout update", { speechModelUnloadTimeout }),
    ),
  });
});

export const layer = Layer.effect(Upstream.SpeechService, make).pipe(Layer.provide(Upstream.layer));
