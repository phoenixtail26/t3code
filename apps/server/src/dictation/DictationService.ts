/**
 * Local speech-to-text for the chat composer. Requests run one at a time; the
 * model downloads on first use, loads into a worker on the first request (never
 * at server start), and the worker stops after an hour idle.
 */
import {
  DEFAULT_SERVER_SETTINGS,
  DICTATION_MAX_AUDIO_BYTES,
  type DictationStatus,
  type DictationTranscript,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { cleanTranscript } from "./cleanup.ts";
import {
  DictationModelDownloadError,
  type DictationModelPaths,
  DictationModelRemoveError,
  type DictationModelSpec,
  downloadModel,
  isModelPresent,
  PARAKEET_TDT_V2_MODEL,
  removeModel,
} from "./model.ts";
import * as DictationWorker from "./worker.ts";

/** The cold load costs ~1 s (up to ~6 s on a machine's first Vulkan run), so the model stays warm this long. */
const DICTATION_IDLE_UNLOAD = Duration.minutes(60);

export class DictationInvalidAudioError extends Schema.TaggedError<DictationInvalidAudioError>()(
  "DictationInvalidAudioError",
  { byteLength: Schema.Number },
) {
  override get message(): string {
    return this.byteLength > DICTATION_MAX_AUDIO_BYTES
      ? "Recordings are limited to five minutes."
      : "Audio must be non-empty 16 kHz mono 16-bit PCM.";
  }
}

type DictationTranscribeError =
  | DictationInvalidAudioError
  | DictationModelDownloadError
  | DictationWorker.DictationWorkerError;

export class DictationService extends Context.Service<
  DictationService,
  {
    /** Transcribes 16 kHz mono little-endian Int16 PCM, downloading the model first if needed. */
    readonly transcribe: (
      pcm: Uint8Array,
    ) => Effect.Effect<DictationTranscript, DictationTranscribeError>;
    readonly status: Effect.Effect<DictationStatus>;
    /** Downloads the model if it is missing and waits until it is ready. */
    readonly downloadModel: Effect.Effect<void, DictationModelDownloadError>;
    /** Stops any download, unloads the model and deletes it. */
    readonly removeModel: Effect.Effect<void, DictationModelRemoveError>;
  }
>()("t3/dictation/DictationService") {}

interface Download {
  readonly done: Deferred.Deferred<void, DictationModelDownloadError>;
  readonly fiber: Fiber.Fiber<void>;
}

const make = Effect.fn("DictationService.make")(function* (model: DictationModelSpec) {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const workers = yield* DictationWorker.DictationWorker;
  const serverSettings = yield* ServerSettingsService;
  const context = yield* Effect.context<FileSystem.FileSystem | HttpClient.HttpClient>();
  const scope = yield* Effect.scope;

  const directory = path.join(config.baseDir, "models", "dictation");
  const paths: DictationModelPaths = {
    directory,
    file: path.join(directory, model.fileName),
    partial: path.join(directory, `${model.fileName}.part`),
  };

  const last = yield* Ref.make<DictationTranscript | null>(null);
  const downloadPercent = yield* Ref.make(0);
  const download = yield* Ref.make(Option.none<Download>());
  const downloadLock = yield* Semaphore.make(1);
  const worker = yield* Ref.make(Option.none<DictationWorker.DictationWorkerProcess>());
  const idleTimer = yield* Ref.make(Option.none<Fiber.Fiber<void>>());
  const jobs = yield* Queue.unbounded<Effect.Effect<void>>();

  const modelPresent = isModelPresent(model, paths).pipe(Effect.provideContext(context));

  // Starts the download unless one is running; both read and write happen
  // under the lock, so the finishing fiber never clears a newer download.
  const startDownload = downloadLock.withPermits(1)(
    Effect.gen(function* () {
      const running = yield* Ref.get(download);
      if (Option.isSome(running)) return running.value.done;
      const done = yield* Deferred.make<void, DictationModelDownloadError>();
      yield* Ref.set(downloadPercent, 0);
      yield* Effect.logInfo("dictation model download started", { url: model.url });
      const fiber = yield* downloadModel(model, paths, (percent) =>
        Ref.set(downloadPercent, percent),
      ).pipe(
        Effect.provideContext(context),
        Effect.tap(() => Effect.logInfo("dictation model downloaded and verified")),
        Effect.tapError((error) => Effect.logWarning("dictation model download failed", { error })),
        // Cleared before waiters resume, so they never read a stale "downloading".
        Effect.ensuring(downloadLock.withPermits(1)(Ref.set(download, Option.none()))),
        Deferred.into(done),
        Effect.asVoid,
        Effect.forkIn(scope),
      );
      yield* Ref.set(download, Option.some({ done, fiber }));
      return done;
    }),
  );

  const ensureModel = Effect.gen(function* () {
    if (yield* modelPresent) return;
    yield* Deferred.await(yield* startDownload);
  });

  const unloadWorker = Effect.gen(function* () {
    const current = yield* Ref.getAndSet(worker, Option.none());
    if (Option.isSome(current)) yield* current.value.kill;
  }).pipe(Effect.uninterruptible);

  const cancelIdleTimer = Effect.gen(function* () {
    const timer = yield* Ref.getAndSet(idleTimer, Option.none());
    if (Option.isSome(timer)) yield* Fiber.interrupt(timer.value);
  });

  const startIdleTimer = Effect.gen(function* () {
    if (Option.isNone(yield* Ref.get(worker))) return;
    const timer = yield* Effect.sleep(DICTATION_IDLE_UNLOAD).pipe(
      Effect.andThen(Effect.logInfo("dictation model unloaded after idle")),
      Effect.andThen(unloadWorker),
      Effect.forkIn(scope),
    );
    yield* Ref.set(idleTimer, Option.some(timer));
  });

  const loadedWorker = Effect.gen(function* () {
    const current = yield* Ref.get(worker);
    if (Option.isSome(current)) return current.value;
    const started = yield* workers.spawn(paths.file);
    yield* Effect.logInfo("dictation model loaded", { backend: started.backend });
    yield* Ref.set(worker, Option.some(started));
    return started;
  });

  const runTranscription = Effect.fn("DictationService.runTranscription")(function* (
    samples: Int16Array,
  ) {
    yield* cancelIdleTimer;
    yield* ensureModel;
    const loaded = yield* loadedWorker;
    const raw = yield* loaded.transcribe(samples).pipe(
      // A failed worker is replaced on the next request.
      Effect.tapError((error) =>
        Effect.logWarning("dictation worker failed", { error }).pipe(Effect.andThen(unloadWorker)),
      ),
    );
    // Unreadable settings fall back to the defaults rather than losing the transcript.
    const cleanup = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.dictation),
      Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.dictation),
    );
    const transcript: DictationTranscript = { text: cleanTranscript(raw, cleanup), raw };
    yield* Ref.set(last, transcript);
    return transcript;
  }, Effect.ensuring(startIdleTimer));

  // Every job runs on this one fiber, so requests never overlap and finish in
  // the order they arrived.
  const enqueue = Effect.fn("DictationService.enqueue")(function* <A, E>(job: Effect.Effect<A, E>) {
    const done = yield* Deferred.make<A, E>();
    yield* Queue.offer(jobs, job.pipe(Deferred.into(done), Effect.asVoid));
    return yield* Deferred.await(done);
  });

  yield* Queue.take(jobs).pipe(Effect.flatten, Effect.forever, Effect.forkIn(scope));
  yield* Effect.addFinalizer(() => cancelIdleTimer.pipe(Effect.andThen(unloadWorker)));

  const transcribe: DictationService["Service"]["transcribe"] = Effect.fn(
    "DictationService.transcribe",
  )(function* (pcm: Uint8Array) {
    if (
      pcm.byteLength === 0 ||
      pcm.byteLength % 2 !== 0 ||
      pcm.byteLength > DICTATION_MAX_AUDIO_BYTES
    ) {
      return yield* new DictationInvalidAudioError({ byteLength: pcm.byteLength });
    }
    // Copy into an aligned buffer; the request body may start at any offset.
    const samples = new Int16Array(pcm.byteLength / 2);
    new Uint8Array(samples.buffer).set(pcm);
    return yield* enqueue(runTranscription(samples));
  });

  const status: DictationService["Service"]["status"] = Effect.gen(function* () {
    const running = yield* Ref.get(download);
    const state: DictationStatus["model"] = Option.isSome(running)
      ? { state: "downloading", percent: yield* Ref.get(downloadPercent) }
      : (yield* modelPresent)
        ? { state: "ready" }
        : { state: "missing" };
    return {
      model: state,
      file: { path: paths.file, sizeBytes: model.sizeBytes },
      last: yield* Ref.get(last),
    };
  });

  const cancelDownload = Effect.gen(function* () {
    const running = yield* downloadLock.withPermits(1)(Ref.get(download));
    if (Option.isNone(running)) return;
    // Waiters get a typed failure, not an interruption.
    yield* Deferred.fail(
      running.value.done,
      new DictationModelDownloadError({ stage: "cancelled" }),
    );
    yield* Fiber.interrupt(running.value.fiber);
  });

  // Cancelled before queuing, since a queued transcription may be waiting on
  // the download; cancelled again in the job in case one restarted it.
  const remove: DictationService["Service"]["removeModel"] = cancelDownload.pipe(
    Effect.andThen(
      enqueue(
        Effect.gen(function* () {
          yield* cancelDownload;
          yield* cancelIdleTimer;
          yield* unloadWorker;
          yield* removeModel(paths).pipe(Effect.provideContext(context));
          yield* Effect.logInfo("dictation model removed");
        }),
      ),
    ),
  );

  return DictationService.of({
    transcribe,
    status,
    downloadModel: ensureModel,
    removeModel: remove,
  });
});

/** The service for a given model; tests use a small fake one. */
export const layerWithModel = (model: DictationModelSpec) =>
  Layer.effect(DictationService, make(model));

export const layer = layerWithModel(PARAKEET_TDT_V2_MODEL);
