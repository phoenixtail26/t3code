// Fork feature: dictation. Opens the microphone, downsamples to 16 kHz mono
// Int16 PCM and exposes a loudness reading for the level meter.
import { DICTATION_SAMPLE_RATE } from "@t3tools/contracts";

import { concatInt16, PcmResampler } from "./resample";

export interface ActiveRecorder {
  /** Stops the microphone and returns everything captured so far. */
  stop(): Int16Array;
  /** Stops the microphone and discards the audio. */
  cancel(): void;
  /** Current loudness, 0..1, from the analyser. Only meaningful while open. */
  readLevel(): number;
  /** Samples captured so far, at 16 kHz. */
  sampleCount(): number;
}

export type StartRecorder = () => Promise<ActiveRecorder>;

// ScriptProcessorNode is deprecated but needs no separately served worklet
// file, which keeps the packaged desktop app and the phone PWA identical.
const PROCESSOR_BUFFER_SIZE = 4096;

/** Opens the microphone. Rejects with the browser's reason when it cannot. */
export const startMicrophoneRecorder: StartRecorder = async () => {
  if (typeof navigator === "undefined" || navigator.mediaDevices?.getUserMedia === undefined) {
    throw new Error("This browser has no microphone access (a secure origin is required).");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE });
  } catch {
    context = new AudioContext();
  }
  const resampler = new PcmResampler(context.sampleRate);
  const chunks: Array<Int16Array> = [];
  let captured = 0;

  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  const processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
  const silence = context.createGain();
  silence.gain.value = 0;
  processor.onaudioprocess = (event) => {
    const chunk = resampler.push(event.inputBuffer.getChannelData(0));
    chunks.push(chunk);
    captured += chunk.length;
  };
  source.connect(analyser);
  analyser.connect(processor);
  processor.connect(silence);
  silence.connect(context.destination);
  if (context.state === "suspended") await context.resume();

  const levelFrame = new Float32Array(analyser.fftSize);
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    processor.onaudioprocess = null;
    source.disconnect();
    analyser.disconnect();
    processor.disconnect();
    silence.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => undefined);
  };

  return {
    stop: () => {
      close();
      return concatInt16(chunks);
    },
    cancel: close,
    readLevel: () => {
      if (!open) return 0;
      analyser.getFloatTimeDomainData(levelFrame);
      let sum = 0;
      for (const sample of levelFrame) sum += sample * sample;
      // RMS of speech sits well under 1; scale so normal talking fills the meter.
      return Math.min(1, Math.sqrt(sum / levelFrame.length) * 4);
    },
    sampleCount: () => captured,
  };
};
