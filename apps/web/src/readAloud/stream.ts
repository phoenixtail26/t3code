// Fork feature: read aloud. The utterance body starts with its own sample rate. A page on
// another origin than the server (the desktop renderer at t3code-dev://app) sees only the
// CORS-safelisted response headers, so a rate carried in a header alone never reaches it.
import * as Schema from "effect/Schema";

/** Mirrors `apps/server/src/readAloud/http.ts`: "RAPC", the rate as a uint32 LE, then the PCM. */
const STREAM_MAGIC = [0x52, 0x41, 0x50, 0x43] as const;
const PREFIX_LENGTH = 8;

export class ReadAloudStreamError extends Schema.TaggedError<
  ReadAloudStreamError,
  { readonly brand: unique symbol }
>()("ReadAloudStreamError", { message: Schema.String }) {}

const noRate = () =>
  new ReadAloudStreamError({ message: "The speech stream did not say its sample rate." });

export interface UtteranceSink {
  /** Heard once, before the first PCM chunk. */
  readonly onFormat: (sampleRate: number) => void;
  readonly onChunk: (pcm: Uint8Array) => void;
}

export interface UtteranceReader {
  /** The next bytes of the body, in order; the sink hears the format, then every PCM chunk. */
  readonly push: (bytes: Uint8Array) => ReadAloudStreamError | null;
  /** The body ended. */
  readonly end: () => ReadAloudStreamError | null;
}

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (head.byteLength === 0) return tail;
  const joined = new Uint8Array(head.byteLength + tail.byteLength);
  joined.set(head);
  joined.set(tail, head.byteLength);
  return joined;
}

/**
 * Reads an utterance body: the prefix names the rate; a body without one (a server that
 * sends only the header) falls back to the header; neither is a plain failure, never a
 * NaN handed to Web Audio.
 */
export function createUtteranceReader(
  headerSampleRate: string | undefined,
  sink: UtteranceSink,
): UtteranceReader {
  // The bytes seen before the format is known; null once it is, or once the stream failed.
  let pending: Uint8Array | null = new Uint8Array(0);
  let failed = false;
  const declare = (sampleRate: number, pcm: Uint8Array): ReadAloudStreamError | null => {
    pending = null;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      failed = true;
      return noRate();
    }
    sink.onFormat(sampleRate);
    if (pcm.byteLength > 0) sink.onChunk(pcm);
    return null;
  };
  const fromHeader = (pcm: Uint8Array) =>
    declare(headerSampleRate === undefined ? Number.NaN : Number(headerSampleRate), pcm);
  return {
    push(bytes) {
      if (pending === null) {
        if (!failed && bytes.byteLength > 0) sink.onChunk(bytes);
        return null;
      }
      const seen = concat(pending, bytes);
      pending = seen;
      if (seen.byteLength < PREFIX_LENGTH) return null;
      if (!STREAM_MAGIC.every((byte, index) => seen[index] === byte)) return fromHeader(seen);
      const rate = new DataView(seen.buffer, seen.byteOffset, PREFIX_LENGTH).getUint32(4, true);
      return declare(rate, seen.subarray(PREFIX_LENGTH));
    },
    end() {
      // Fewer bytes than a prefix: only the header can name the rate.
      return pending === null ? null : fromHeader(pending);
    },
  };
}
