import * as Schema from "effect/Schema";

/**
 * Dictation: the client records 16 kHz mono Int16 PCM and posts the raw bytes
 * to `POST /api/dictation/transcribe`; the environment server transcribes it
 * locally. `GET /api/dictation/status` reports the model state and the last
 * transcription, `POST /api/dictation/model` downloads the model and
 * `DELETE /api/dictation/model` removes it.
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

export const DictationStatus = Schema.Struct({
  model: DictationModelState,
  /** The last transcription since the server started; kept in memory only. */
  last: Schema.NullOr(DictationTranscript),
});
export type DictationStatus = typeof DictationStatus.Type;

/** Body of every non-2xx dictation response. */
export const DictationErrorResponse = Schema.Struct({ error: Schema.String });
export type DictationErrorResponse = typeof DictationErrorResponse.Type;
