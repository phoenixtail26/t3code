import { describe, expect, it } from "vite-plus/test";

import { concatInt16, floatToInt16, int16ToBytes, PcmResampler, resampleToInt16 } from "./resample";

function sine(rate: number, seconds: number, hz: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  }
  return out;
}

function zeroCrossings(samples: Int16Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] ?? 0;
    const b = samples[i] ?? 0;
    if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) crossings++;
  }
  return crossings;
}

describe("resampleToInt16", () => {
  it("downsamples one second of 48 kHz audio to 16000 samples", () => {
    const out = resampleToInt16(sine(48_000, 1, 440), 48_000);
    expect(out).toBeInstanceOf(Int16Array);
    expect(out.length).toBe(16_000);
  });

  it("keeps the tone: a 440 Hz sine still crosses zero about 880 times a second", () => {
    const out = resampleToInt16(sine(48_000, 1, 440), 48_000);
    const crossings = zeroCrossings(out);
    expect(crossings).toBeGreaterThanOrEqual(878);
    expect(crossings).toBeLessThanOrEqual(882);
  });

  it("scales amplitude to the Int16 range", () => {
    const out = resampleToInt16(sine(48_000, 0.1, 100, 0.5), 48_000);
    let peak = 0;
    for (const sample of out) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeGreaterThan(0x7fff * 0.49);
    expect(peak).toBeLessThanOrEqual(0x7fff * 0.5 + 1);
  });

  it("passes 16 kHz input through unchanged in length", () => {
    expect(resampleToInt16(sine(16_000, 0.5, 300), 16_000).length).toBe(8_000);
  });
});

describe("PcmResampler", () => {
  it("produces the same sample count whether audio arrives whole or in capture-sized chunks", () => {
    const whole = sine(48_000, 2, 440);
    const oneShot = resampleToInt16(whole, 48_000);
    const streaming = new PcmResampler(48_000);
    const chunks: Array<Int16Array> = [];
    for (let offset = 0; offset < whole.length; offset += 4096) {
      chunks.push(streaming.push(whole.subarray(offset, offset + 4096)));
    }
    const joined = concatInt16(chunks);
    expect(joined.length).toBe(oneShot.length);
    // Seams carry the fractional position, so the streams agree sample for sample.
    let maxDiff = 0;
    for (let i = 0; i < joined.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs((joined[i] ?? 0) - (oneShot[i] ?? 0)));
    }
    expect(maxDiff).toBeLessThanOrEqual(1);
  });

  it("rejects a non-positive rate", () => {
    expect(() => new PcmResampler(0)).toThrow(RangeError);
  });
});

describe("floatToInt16 and int16ToBytes", () => {
  it("clamps and rounds", () => {
    expect(floatToInt16(0)).toBe(0);
    expect(floatToInt16(1)).toBe(0x7fff);
    expect(floatToInt16(-1)).toBe(-0x8000);
    expect(floatToInt16(2)).toBe(0x7fff);
    expect(floatToInt16(-2)).toBe(-0x8000);
  });

  it("exposes little-endian bytes of the same buffer", () => {
    const bytes = int16ToBytes(Int16Array.of(1, -1));
    expect(Array.from(bytes)).toEqual([1, 0, 0xff, 0xff]);
  });
});
