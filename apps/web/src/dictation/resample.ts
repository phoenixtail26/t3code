// Fork feature: dictation. Converts microphone audio to the 16 kHz mono Int16
// PCM the server's transcription route expects.
import { DICTATION_SAMPLE_RATE } from "@t3tools/contracts";

/**
 * Streaming linear-interpolation resampler. Chunks arrive at the capture
 * rate; each `push` returns the samples that fall inside that chunk and
 * carries the fractional read position into the next one so chunk seams
 * produce no clicks.
 */
export class PcmResampler {
  readonly #ratio: number;
  #position = 0;

  constructor(inputRate: number, outputRate: number = DICTATION_SAMPLE_RATE) {
    if (!(inputRate > 0) || !(outputRate > 0)) {
      throw new RangeError("Sample rates must be positive.");
    }
    this.#ratio = inputRate / outputRate;
  }

  push(input: Float32Array): Int16Array {
    const out: Array<number> = [];
    let position = this.#position;
    while (position < input.length) {
      const index = Math.floor(position);
      const a = input[index] ?? 0;
      const b = input[index + 1] ?? a;
      out.push(floatToInt16(a + (b - a) * (position - index)));
      position += this.#ratio;
    }
    this.#position = position - input.length;
    return Int16Array.from(out);
  }
}

export function floatToInt16(sample: number): number {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

/** One-shot convenience for whole buffers. */
export function resampleToInt16(
  input: Float32Array,
  inputRate: number,
  outputRate: number = DICTATION_SAMPLE_RATE,
): Int16Array {
  return new PcmResampler(inputRate, outputRate).push(input);
}

export function concatInt16(chunks: ReadonlyArray<Int16Array>): Int16Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Raw little-endian bytes of the samples, as the transcribe route reads them. */
export function int16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}
