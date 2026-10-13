// @effect-diagnostics nodeBuiltinImport:off -- the fake model's checksum is computed with node:crypto.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DictationService from "./DictationService.ts";
import type { DictationModelSpec } from "./model.ts";
import * as DictationWorker from "./worker.ts";

const MODEL_BYTES = new TextEncoder().encode("fake gguf model bytes");

const TEST_MODEL: DictationModelSpec = {
  fileName: "test-model.gguf",
  url: "https://models.test/test-model.gguf",
  sha256: NodeCrypto.createHash("sha256").update(MODEL_BYTES).digest("hex"),
  sizeBytes: MODEL_BYTES.byteLength,
};

/** Two Int16 samples of value `marker`; the fake worker answers "heard <marker>". */
const pcm = (marker: number) => new Uint8Array(new Int16Array([marker, marker]).buffer);

const makeFakeWorkers = Effect.gen(function* () {
  const counts = { spawned: 0, killed: 0, running: 0, maxRunning: 0 };
  const heard: Array<number> = [];
  const started = yield* Queue.unbounded<number>();
  const killed = yield* Queue.unbounded<void>();
  const control: { hold?: Deferred.Deferred<void>; failNext: boolean } = { failNext: false };

  const transcribe = (samples: Int16Array) =>
    Effect.gen(function* () {
      const marker = samples[0] ?? 0;
      counts.running++;
      counts.maxRunning = Math.max(counts.maxRunning, counts.running);
      heard.push(marker);
      yield* Queue.offer(started, marker);
      if (control.hold) yield* Deferred.await(control.hold);
      counts.running--;
      if (control.failNext) {
        control.failNext = false;
        return yield* new DictationWorker.DictationWorkerError({ stage: "exited" });
      }
      return `heard ${marker}`;
    });

  const service = DictationWorker.DictationWorker.of({
    spawn: () =>
      Effect.sync(() => {
        counts.spawned++;
        return {
          backend: "fake",
          transcribe,
          kill: Effect.sync(() => {
            counts.killed++;
          }).pipe(Effect.andThen(Queue.offer(killed, undefined)), Effect.asVoid),
        };
      }),
  });
  return { counts, heard, started, killed, control, service };
});

type FakeWorkers = Effect.Success<typeof makeFakeWorkers>;

const httpServing = (body: Uint8Array) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body.slice()))),
    ),
  );

const layerTest = (
  workers: FakeWorkers,
  options: {
    readonly model?: DictationModelSpec;
    readonly serve?: Uint8Array;
    readonly http?: Layer.Layer<HttpClient.HttpClient>;
    readonly dictionary?: string;
  } = {},
) =>
  DictationService.layerWithModel(options.model ?? TEST_MODEL).pipe(
    Layer.provide(Layer.succeed(DictationWorker.DictationWorker, workers.service)),
    Layer.provide(
      ServerSettings.layerTest({ dictation: { dictionary: options.dictionary ?? "" } }),
    ),
    Layer.provide(options.http ?? httpServing(options.serve ?? new Uint8Array())),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-dictation-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const modelFile = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.baseDir, "models", "dictation", TEST_MODEL.fileName);
});

const installModel = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* modelFile;
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  yield* fileSystem.writeFile(file, MODEL_BYTES);
});

describe("DictationService", () => {
  it.effect("does not start the worker before the first request", () =>
    Effect.gen(function* () {
      const workers = yield* makeFakeWorkers;
      yield* Effect.gen(function* () {
        yield* installModel;
        const dictation = yield* DictationService.DictationService;

        expect(yield* dictation.status).toEqual({
          model: { state: "ready" },
          file: { path: yield* modelFile, sizeBytes: TEST_MODEL.sizeBytes },
          last: null,
        });
        expect(workers.counts.spawned).toBe(0);

        const transcript = yield* dictation.transcribe(pcm(7));
        expect(transcript).toEqual({ text: "heard 7", raw: "heard 7" });
        expect(workers.counts.spawned).toBe(1);
        expect((yield* dictation.status).last).toEqual(transcript);
      }).pipe(Effect.provide(layerTest(workers)));
    }),
  );

  it.effect("cleans the transcript with the settings dictionary and keeps both texts", () =>
    Effect.gen(function* () {
      const workers = yield* makeFakeWorkers;
      yield* Effect.gen(function* () {
        yield* installModel;
        const dictation = yield* DictationService.DictationService;

        const transcript = yield* dictation.transcribe(pcm(3));
        expect(transcript).toEqual({ text: "Heard 3", raw: "heard 3" });
        expect((yield* dictation.status).last).toEqual(transcript);
      }).pipe(Effect.provide(layerTest(workers, { dictionary: "heard => Heard" })));
    }),
  );

  it.effect("runs overlapping requests one at a time, in arrival order", () =>
    Effect.gen(function* () {
      const workers = yield* makeFakeWorkers;
      yield* Effect.gen(function* () {
        yield* installModel;
        const dictation = yield* DictationService.DictationService;
        const release = yield* Deferred.make<void>();
        workers.control.hold = release;

        const first = yield* Effect.forkChild(dictation.transcribe(pcm(1)));
        const second = yield* Effect.forkChild(dictation.transcribe(pcm(2)));
        const third = yield* Effect.forkChild(dictation.transcribe(pcm(3)));
        expect(yield* Queue.take(workers.started)).toBe(1);
        expect(workers.heard).toEqual([1]);

        yield* Deferred.succeed(release, undefined);
        const texts = yield* Fiber.joinAll([first, second, third]);
        expect(texts.map((transcript) => transcript.text)).toEqual([
          "heard 1",
          "heard 2",
          "heard 3",
        ]);
        expect(workers.heard).toEqual([1, 2, 3]);
        expect(workers.counts.maxRunning).toBe(1);
        expect(workers.counts.spawned).toBe(1);
      }).pipe(Effect.provide(layerTest(workers)));
    }),
  );

  it.effect("unloads the model after an hour idle and reloads it on the next request", () =>
    Effect.gen(function* () {
      const workers = yield* makeFakeWorkers;
      yield* Effect.gen(function* () {
        yield* installModel;
        const dictation = yield* DictationService.DictationService;

        yield* dictation.transcribe(pcm(1));
        yield* TestClock.adjust(Duration.minutes(50));
        // A request inside the hour restarts the idle countdown.
        yield* dictation.transcribe(pcm(2));
        yield* TestClock.adjust(Duration.minutes(50));
        expect(workers.counts).toMatchObject({ spawned: 1, killed: 0 });

        yield* TestClock.adjust(Duration.minutes(11));
        yield* Queue.take(workers.killed);
        expect(workers.counts).toMatchObject({ spawned: 1, killed: 1 });

        yield* dictation.transcribe(pcm(3));
        expect(workers.counts.spawned).toBe(2);
      }).pipe(Effect.provide(layerTest(workers)));
    }),
  );

  it.effect("replaces a worker that failed", () =>
    Effect.gen(function* () {
      const workers = yield* makeFakeWorkers;
      yield* Effect.gen(function* () {
        yield* installModel;
        const dictation = yield* DictationService.DictationService;
        workers.control.failNext = true;

        const failure = yield* Effect.flip(dictation.transcribe(pcm(1)));
        expect(failure._tag).toBe("DictationWorkerError");
        yield* Queue.take(workers.killed);

        expect((yield* dictation.transcribe(pcm(2))).text).toBe("heard 2");
        expect(workers.counts.spawned).toBe(2);
      }).pipe(Effect.provide(layerTest(workers)));
    }),
  );

  it.effect("rejects empty, odd-length and over-long audio without starting the worker", () =>
    Effect.gen(function* () {
      const workers = yield* makeFakeWorkers;
      yield* Effect.gen(function* () {
        yield* installModel;
        const dictation = yield* DictationService.DictationService;
        for (const body of [new Uint8Array(0), new Uint8Array(3), new Uint8Array(9_600_002)]) {
          const failure = yield* Effect.flip(dictation.transcribe(body));
          expect(failure._tag).toBe("DictationInvalidAudioError");
        }
        expect(workers.counts.spawned).toBe(0);
      }).pipe(Effect.provide(layerTest(workers)));
    }),
  );

  it.effect("downloads a missing model on first use and verifies it", () =>
    Effect.gen(function* () {
      const workers = yield* makeFakeWorkers;
      yield* Effect.gen(function* () {
        const dictation = yield* DictationService.DictationService;
        expect((yield* dictation.status).model).toEqual({ state: "missing" });

        expect((yield* dictation.transcribe(pcm(4))).text).toBe("heard 4");
        expect((yield* dictation.status).model).toEqual({ state: "ready" });
        const fileSystem = yield* FileSystem.FileSystem;
        expect(new Uint8Array(yield* fileSystem.readFile(yield* modelFile))).toEqual(MODEL_BYTES);

        yield* dictation.removeModel;
        expect((yield* dictation.status).model).toEqual({ state: "missing" });
        expect(workers.counts.killed).toBe(1);
      }).pipe(Effect.provide(layerTest(workers, { serve: MODEL_BYTES })));
    }),
  );

  it.effect("remove cancels a download a queued transcription is waiting on", () =>
    Effect.gen(function* () {
      const workers = yield* makeFakeWorkers;
      const requested = yield* Deferred.make<void>();
      // The server accepts the request and never answers.
      const stalled = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      );
      yield* Effect.gen(function* () {
        const dictation = yield* DictationService.DictationService;
        const waiting = yield* Effect.forkChild(dictation.transcribe(pcm(6)));
        yield* Deferred.await(requested);
        expect((yield* dictation.status).model).toMatchObject({ state: "downloading" });

        yield* dictation.removeModel;
        const failure = yield* Effect.flip(Fiber.join(waiting));
        expect(failure).toMatchObject({ _tag: "DictationModelDownloadError", stage: "cancelled" });
        expect((yield* dictation.status).model).toEqual({ state: "missing" });
        expect(workers.counts.spawned).toBe(0);
      }).pipe(Effect.provide(layerTest(workers, { http: stalled })));
    }),
  );

  it.effect("discards a download whose checksum does not match", () =>
    Effect.gen(function* () {
      const workers = yield* makeFakeWorkers;
      const tampered = new TextEncoder().encode("fake gguf model byteZ");
      yield* Effect.gen(function* () {
        const dictation = yield* DictationService.DictationService;

        const failure = yield* Effect.flip(dictation.transcribe(pcm(5)));
        expect(failure).toMatchObject({ _tag: "DictationModelDownloadError", stage: "verify" });
        expect((yield* dictation.status).model).toEqual({ state: "missing" });
        const fileSystem = yield* FileSystem.FileSystem;
        const file = yield* modelFile;
        expect(yield* fileSystem.exists(file)).toBe(false);
        expect(yield* fileSystem.exists(`${file}.part`)).toBe(false);
        expect(workers.counts.spawned).toBe(0);
      }).pipe(Effect.provide(layerTest(workers, { serve: tampered })));
    }),
  );
});
