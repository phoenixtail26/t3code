import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";
import { expect, it } from "vite-plus/test";

import utteranceUrl from "./fixtures/utterance.rapc?url";
import { createPcmScheduler } from "./player";
import { createUtteranceReader } from "./stream";

// The served fixture: "RAPC", 24000, then 0.1 s of a 440 Hz sine (2392 of 2400 samples non-zero).
const FIXTURE_RATE = 24_000;
const FIXTURE_SAMPLES = 2400;

// A served file carries no read-aloud header, which is what a page on another origin than the
// server sees too (the desktop renderer): the body alone has to name the rate.
it("decodes a served stream with no sample-rate header, the rate read from the body", async () => {
  const chunks: Uint8Array[] = [];
  const formats: number[] = [];
  const reader = createUtteranceReader(undefined, {
    onFormat: (rate) => formats.push(rate),
    onChunk: (pcm) => chunks.push(pcm),
  });
  const received = await Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(utteranceUrl);
    expect(response.status).toBe(200);
    expect(response.headers["read-aloud-sample-rate"]).toBeUndefined();
    let bytes = 0;
    yield* Stream.runForEach(response.stream, (chunk) =>
      Effect.sync(() => {
        bytes += chunk.byteLength;
        expect(reader.push(chunk)).toBeNull();
      }),
    );
    expect(reader.end()).toBeNull();
    return bytes;
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.runPromise);

  expect(received).toBe(8 + FIXTURE_SAMPLES * 2);
  expect(formats).toEqual([FIXTURE_RATE]);
  const pcmBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  expect(pcmBytes).toBe(FIXTURE_SAMPLES * 2);

  // The buffers the player builds from it, rendered offline: no device, no sound. The player
  // schedules the first buffer a little ahead of the clock, so the render is longer than the sound.
  const context = new OfflineAudioContext(1, FIXTURE_SAMPLES * 2, FIXTURE_RATE);
  const built: Array<{ sampleRate: number; length: number }> = [];
  const createBuffer = context.createBuffer.bind(context);
  context.createBuffer = (channels, length, sampleRate) => {
    const buffer = createBuffer(channels, length, sampleRate);
    built.push({ sampleRate: buffer.sampleRate, length: buffer.length });
    return buffer;
  };
  const scheduler = createPcmScheduler(context, formats[0]!);
  for (const chunk of chunks) scheduler.push(chunk);
  const rendered = await context.startRendering();

  expect(built.length).toBeGreaterThan(0);
  expect(built.map((buffer) => buffer.sampleRate)).toEqual(built.map(() => FIXTURE_RATE));
  expect(built.reduce((sum, buffer) => sum + buffer.length, 0)).toBe(FIXTURE_SAMPLES);
  const samples = rendered.getChannelData(0);
  let nonZero = 0;
  for (let index = 0; index < samples.length; index += 1) if (samples[index] !== 0) nonZero += 1;
  expect(nonZero).toBeGreaterThan(FIXTURE_SAMPLES / 2);
  expect(nonZero).toBeLessThanOrEqual(FIXTURE_SAMPLES);
});
