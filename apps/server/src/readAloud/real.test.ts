// @effect-diagnostics nodeBuiltinImport:off - writes the WAV beside the repo for a person to check.
/* oxlint-disable t3code/no-wall-clock-in-tests -- the timing is reported for the person who runs this, never asserted; it runs only behind READ_ALOUD_HEARSAY_URL */
// Opt-in, against a real `hearsay serve` you started yourself (never the one on 47700):
//   READ_ALOUD_HEARSAY_URL=http://127.0.0.1:47790 vp test run src/readAloud/real.test.ts
// It speaks one reply through the service, writes `.scratch/real-speak.wav` at the repo root
// (never played by the test) and prints the time from the request to the first PCM byte.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as ReadAloud from "./ReadAloudService.ts";
import { speakableText } from "./speakableText.ts";

const url = process.env.READ_ALOUD_HEARSAY_URL;
const token = process.env.READ_ALOUD_HEARSAY_TOKEN ?? "";
const scratch = NodePath.resolve(import.meta.dirname, "../../../../.scratch");

const REPLY = `## Results

The build passed and all **34 tests** are green. Run them yourself with:

\`\`\`sh
pnpm test
\`\`\`

- The server route streams the PCM.
- The button stops it.

Next, try it on the phone.`;

function wav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new DataView(new ArrayBuffer(44));
  const ascii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1)
      header.setUint8(offset + index, value.charCodeAt(index));
  };
  ascii(0, "RIFF");
  header.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  ascii(36, "data");
  header.setUint32(40, pcm.byteLength, true);
  const file = new Uint8Array(44 + pcm.byteLength);
  file.set(new Uint8Array(header.buffer), 0);
  file.set(pcm, 44);
  return file;
}

it.live.skipIf(!url)("speaks a reply through a real Hearsay and writes the WAV", () =>
  Effect.gen(function* () {
    const service = yield* ReadAloud.ReadAloudService;
    const started = performance.now();
    const utterance = yield* service.speak(speakableText(REPLY));
    const chunks: Uint8Array[] = [];
    let firstByteAt = 0;
    yield* Stream.runForEach(utterance.audio, (chunk) =>
      Effect.sync(() => {
        if (chunks.length === 0) firstByteAt = performance.now();
        chunks.push(chunk);
      }),
    );
    const doneAt = performance.now();
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const pcm = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(total).toBeGreaterThan(0);
    NodeFS.mkdirSync(scratch, { recursive: true });
    const out = NodePath.join(scratch, "real-speak.wav");
    NodeFS.writeFileSync(out, wav(pcm, utterance.sampleRate));
    yield* Effect.log(
      JSON.stringify({
        url,
        sampleRate: utterance.sampleRate,
        chunks: chunks.length,
        seconds: total / 2 / utterance.sampleRate,
        msToFirstPcmByte: Math.round(firstByteAt - started),
        msToDone: Math.round(doneAt - started),
        wav: out,
      }),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ReadAloud.layer.pipe(
        Layer.provide(
          Layer.merge(
            Layer.mock(ProjectionStoreV2.ProjectionStoreV2)({}),
            ServerSettings.layerTest({ hearsaySpeech: { url: url ?? "", token } }),
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
