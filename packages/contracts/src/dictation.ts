import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Dictation: the client posts 16 kHz mono Int16 PCM to
 * `POST /api/dictation/transcribe` and the server transcribes it locally.
 * `/api/dictation/status` reports model state; `POST`/`DELETE`
 * `/api/dictation/model` download and remove the model.
 */

export const DICTATION_TRANSCRIBE_PATH = "/api/dictation/transcribe";
export const DICTATION_STATUS_PATH = "/api/dictation/status";
export const DICTATION_MODEL_PATH = "/api/dictation/model";

export const DICTATION_SAMPLE_RATE = 16_000;
export const DICTATION_MAX_SECONDS = 5 * 60;
/** Five minutes of 16 kHz mono Int16 PCM: 9.6 MB. */
export const DICTATION_MAX_AUDIO_BYTES = DICTATION_MAX_SECONDS * DICTATION_SAMPLE_RATE * 2;

export const DictationModelState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("missing") }),
  Schema.Struct({
    state: Schema.Literal("downloading"),
    /** Whole percent, 0-100. */
    percent: Schema.Number,
  }),
  Schema.Struct({ state: Schema.Literal("ready") }),
]);
export type DictationModelState = typeof DictationModelState.Type;

/** `raw` is the engine output; `text` is what the client inserts. */
export const DictationTranscript = Schema.Struct({
  text: Schema.String,
  raw: Schema.String,
});
export type DictationTranscript = typeof DictationTranscript.Type;

/** Where the model lives and how big it is, reported whether or not it is present. */
export const DictationModelFile = Schema.Struct({
  path: Schema.String,
  sizeBytes: Schema.Number,
});
export type DictationModelFile = typeof DictationModelFile.Type;

export const DictationStatus = Schema.Struct({
  model: DictationModelState,
  file: DictationModelFile,
  /** The last transcription since the server started; kept in memory only. */
  last: Schema.NullOr(DictationTranscript),
});
export type DictationStatus = typeof DictationStatus.Type;

/** Body of every non-2xx dictation response. */
export const DictationErrorResponse = Schema.Struct({ error: Schema.String });
export type DictationErrorResponse = typeof DictationErrorResponse.Type;

/** Server settings for transcript cleanup; see `apps/server/src/dictation/cleanup.ts`. */
export const DictationSettings = Schema.Struct({
  fillerCleanup: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** One `heard => wanted` entry per line, matched case-insensitively as whole words. */
  dictionary: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type DictationSettings = typeof DictationSettings.Type;

export const DictationSettingsPatch = Schema.Struct({
  fillerCleanup: Schema.optionalKey(Schema.Boolean),
  dictionary: Schema.optionalKey(Schema.String),
});
