// Fork feature: read aloud. One utterance at a time, played through Web Audio as its PCM
// arrives: each chunk is scheduled to start where the last one ends, so there are no gaps
// and no clicks. Nothing here repaints; the store changes only when the state does.
import { toastManager } from "~/components/ui/toast";

import { speak } from "./api";
import { readReadAloudState, setReadAloudState, type ReadAloudTarget } from "./store";

// Scheduled this far ahead of the clock so the first buffer is not already late.
const LEAD_SECONDS = 0.05;

interface Playback {
  readonly target: ReadAloudTarget;
  readonly context: AudioContext;
  readonly stop: () => void;
  stopped: boolean;
}

let playback: Playback | null = null;

type Scheduler = ReturnType<typeof createPcmScheduler>;

/** Int16 little-endian PCM as Web Audio's Float32 samples; an odd trailing byte is carried. */
export function createPcmScheduler(context: BaseAudioContext, sampleRate: number) {
  let carry: number | null = null;
  let nextStart = 0;
  let outstanding = 0;
  let finished = false;
  let onDrained: (() => void) | null = null;
  const sources = new Set<AudioBufferSourceNode>();
  const settle = () => {
    if (finished && outstanding === 0) onDrained?.();
  };
  return {
    push(bytes: Uint8Array) {
      let data = bytes;
      if (carry !== null) {
        data = new Uint8Array(bytes.byteLength + 1);
        data[0] = carry;
        data.set(bytes, 1);
        carry = null;
      }
      const samples = Math.floor(data.byteLength / 2);
      if (data.byteLength % 2 === 1) carry = data[data.byteLength - 1]!;
      if (samples === 0) return;
      const view = new DataView(data.buffer, data.byteOffset, samples * 2);
      const buffer = context.createBuffer(1, samples, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < samples; index += 1)
        channel[index] = view.getInt16(index * 2, true) / 32768;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      nextStart = Math.max(nextStart, context.currentTime + LEAD_SECONDS);
      source.start(nextStart);
      nextStart += buffer.duration;
      outstanding += 1;
      sources.add(source);
      source.onended = () => {
        sources.delete(source);
        outstanding -= 1;
        settle();
      };
    },
    /** Resolves once every scheduled buffer has played. */
    drained: () =>
      new Promise<void>((resolve) => {
        finished = true;
        onDrained = resolve;
        settle();
      }),
    stopAll() {
      for (const source of sources) source.stop();
      sources.clear();
    },
  };
}

function describeAudioFailure(error: unknown): string {
  return error instanceof Error ? error.message : "Audio playback failed.";
}

export function stopReadAloud(): void {
  playback?.stop();
}

/** Speaks one reply, stopping whatever was being read. Call from a user gesture. */
export function startReadAloud(target: ReadAloudTarget): void {
  stopReadAloud();
  const context = new AudioContext();
  void context.resume();
  let release: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduling: { current: Scheduler | null } = { current: null };
  const current: Playback = {
    target,
    context,
    stopped: false,
    stop() {
      if (current.stopped) return;
      current.stopped = true;
      release();
      scheduling.current?.stopAll();
      void context.close();
      if (playback === current) playback = null;
      setReadAloudState({ state: "idle" });
    },
  };
  playback = current;
  setReadAloudState({ state: "loading", target });

  void (async () => {
    const result = await speak({
      environmentId: target.environmentId,
      threadId: target.threadId,
      messageId: target.messageId,
      ...(target.mode ? { mode: target.mode } : {}),
      stop: stopped,
      onFormat: (sampleRate) => {
        scheduling.current = createPcmScheduler(context, sampleRate);
      },
      onChunk: (pcm) => {
        if (current.stopped || !scheduling.current) return;
        scheduling.current.push(pcm);
        if (readReadAloudState().state === "loading")
          setReadAloudState({ state: "playing", target });
      },
    }).catch((error: unknown) => ({ ok: false as const, error: describeAudioFailure(error) }));
    if (current.stopped) return;
    if (!result.ok) {
      toastManager.add({ type: "error", title: "Could not read aloud", description: result.error });
      current.stop();
      return;
    }
    if (scheduling.current) await scheduling.current.drained();
    current.stop();
  })();
}
