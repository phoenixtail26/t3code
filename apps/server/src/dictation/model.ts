// @effect-diagnostics nodeBuiltinImport:off -- the SHA-256 of the download is hashed incrementally with node:crypto while it streams to disk.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

/** One downloadable GGUF model, pinned by URL revision, size and SHA-256. */
export interface DictationModelSpec {
  readonly fileName: string;
  readonly url: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** English Parakeet TDT 0.6B v2, Q8_0. */
export const PARAKEET_TDT_V2_MODEL: DictationModelSpec = {
  fileName: "parakeet-tdt-0.6b-v2-Q8_0.gguf",
  url: "https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v2-gguf/resolve/07cee0616125a08ef619729bb47f40ef747e4bc4/parakeet-tdt-0.6b-v2-Q8_0.gguf",
  sha256: "f0d0e99cebb6d3b83f1f7069b82b5d3c2e39a54545b0da039cb4bafd9c4e5caa",
  sizeBytes: 729_574_912,
};

/** Where a model lives: `<T3 home>/models/dictation/<file>`, downloaded through `<file>.part`. */
export interface DictationModelPaths {
  readonly directory: string;
  readonly file: string;
  readonly partial: string;
}

export class DictationModelDownloadError extends Schema.TaggedError<DictationModelDownloadError>()(
  "DictationModelDownloadError",
  {
    stage: Schema.Literals(["request", "write", "verify", "cancelled"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "request":
        return "Downloading the dictation model failed.";
      case "write":
        return "Saving the dictation model failed.";
      case "verify":
        return "The downloaded dictation model did not match its checksum.";
      case "cancelled":
        return "The dictation model download was cancelled.";
    }
  }
}

export class DictationModelRemoveError extends Schema.TaggedError<DictationModelRemoveError>()(
  "DictationModelRemoveError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Removing the dictation model failed.";
  }
}

/** A model counts as present when the file exists at its pinned size; the hash is checked once, at download. */
export const isModelPresent = Effect.fn("dictation.isModelPresent")(function* (
  spec: DictationModelSpec,
  paths: DictationModelPaths,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.stat(paths.file).pipe(
    Effect.map((info) => info.type === "File" && Number(info.size) === spec.sizeBytes),
    Effect.orElseSucceed(() => false),
  );
});

/**
 * Streams the model to `<file>.part`, hashing as it goes, and renames it into
 * place only when size and SHA-256 match. `onProgress` gets whole percents.
 */
export const downloadModel = Effect.fn("dictation.downloadModel")(function* (
  spec: DictationModelSpec,
  paths: DictationModelPaths,
  onProgress: (percent: number) => Effect.Effect<void>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const writeError = (cause: unknown) => new DictationModelDownloadError({ stage: "write", cause });
  const requestError = (cause: unknown) =>
    new DictationModelDownloadError({ stage: "request", cause });

  const download = Effect.gen(function* () {
    yield* fileSystem
      .makeDirectory(paths.directory, { recursive: true })
      .pipe(Effect.mapError(writeError));
    const response = yield* httpClient
      .get(spec.url)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.mapError(requestError));

    const hash = NodeCrypto.createHash("sha256");
    let received = 0;
    let reported = -1;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem
          .open(paths.partial, { flag: "w" })
          .pipe(Effect.mapError(writeError));
        yield* response.stream.pipe(
          Stream.mapError(requestError),
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              hash.update(chunk);
              received += chunk.byteLength;
              yield* file.writeAll(chunk).pipe(Effect.mapError(writeError));
              const percent = Math.min(100, Math.floor((received * 100) / spec.sizeBytes));
              if (percent !== reported) {
                reported = percent;
                yield* onProgress(percent);
              }
            }),
          ),
        );
      }),
    );

    if (received !== spec.sizeBytes || hash.digest("hex") !== spec.sha256) {
      return yield* new DictationModelDownloadError({ stage: "verify" });
    }
    yield* fileSystem.rename(paths.partial, paths.file).pipe(Effect.mapError(writeError));
  });

  // A failed or interrupted download never leaves a partial file behind.
  yield* download.pipe(
    Effect.onError(() => fileSystem.remove(paths.partial, { force: true }).pipe(Effect.ignore)),
  );
});

export const removeModel = Effect.fn("dictation.removeModel")(function* (
  paths: DictationModelPaths,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* Effect.forEach([paths.file, paths.partial], (file) =>
    fileSystem.remove(file, { force: true }),
  ).pipe(Effect.mapError((cause) => new DictationModelRemoveError({ cause })));
});
