import { expect, it } from "vite-plus/test";

import { createUtteranceReader } from "./stream";

const NO_RATE = "The speech stream did not say its sample rate.";

function prefix(rate: number): Uint8Array {
  const bytes = new Uint8Array(8);
  bytes.set([0x52, 0x41, 0x50, 0x43]);
  new DataView(bytes.buffer).setUint32(4, rate, true);
  return bytes;
}

const join = (...parts: ReadonlyArray<ArrayLike<number>>) =>
  new Uint8Array(parts.flatMap((part) => Array.from(part)));

function read(chunks: ReadonlyArray<Uint8Array>, header?: string) {
  const formats: number[] = [];
  const pcm: number[][] = [];
  const reader = createUtteranceReader(header, {
    onFormat: (rate) => formats.push(rate),
    onChunk: (chunk) => pcm.push(Array.from(chunk)),
  });
  const errors = [...chunks.map((chunk) => reader.push(chunk)), reader.end()]
    .filter((error) => error !== null)
    .map((error) => error.message);
  return { formats, pcm, errors };
}

it.each([
  {
    name: "the prefix names the rate and the PCM follows, no header needed",
    chunks: [join(prefix(24_000), [1, 0, 2, 0])],
    formats: [24_000],
    pcm: [[1, 0, 2, 0]],
    errors: [],
  },
  {
    name: "a prefix split across chunks, one of a single byte",
    chunks: [
      prefix(24_000).subarray(0, 1),
      prefix(24_000).subarray(1, 5),
      join(prefix(24_000).subarray(5), [1, 0]),
      new Uint8Array([2, 0]),
    ],
    formats: [24_000],
    pcm: [
      [1, 0],
      [2, 0],
    ],
    errors: [],
  },
  {
    name: "a prefix alone declares the format of an empty utterance",
    chunks: [prefix(22_050)],
    formats: [22_050],
    pcm: [],
    errors: [],
  },
  {
    name: "the header's rate is ignored when the prefix names one",
    header: "8000",
    chunks: [join(prefix(24_000), [1, 0])],
    formats: [24_000],
    pcm: [[1, 0]],
    errors: [],
  },
  {
    name: "no prefix: the header's rate, and every byte is PCM",
    header: "24000",
    chunks: [new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0, 5, 0])],
    formats: [24_000],
    pcm: [[1, 0, 2, 0, 3, 0, 4, 0, 5, 0]],
    errors: [],
  },
  {
    name: "a body shorter than a prefix uses the header",
    header: "24000",
    chunks: [new Uint8Array([1, 0])],
    formats: [24_000],
    pcm: [[1, 0]],
    errors: [],
  },
  {
    name: "no prefix and no header is a plain sentence, not a NaN",
    chunks: [new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0, 5, 0])],
    formats: [],
    pcm: [],
    errors: [NO_RATE],
  },
  {
    name: "no prefix and a header that is not a number",
    header: "abc",
    chunks: [new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0, 5, 0])],
    formats: [],
    pcm: [],
    errors: [NO_RATE],
  },
  {
    name: "a prefix with a rate of zero",
    chunks: [join(prefix(0), [1, 0])],
    formats: [],
    pcm: [],
    errors: [NO_RATE],
  },
  {
    name: "an empty body with no header",
    chunks: [],
    formats: [],
    pcm: [],
    errors: [NO_RATE],
  },
])("$name", ({ chunks, header, formats, pcm, errors }) => {
  expect(read(chunks, header)).toEqual({ formats, pcm, errors });
});
