import { DICTATION_SAMPLE_RATE, EnvironmentId, type DictationStatus } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DictationApi, DictationResult } from "./api";
import { DictationController, type DictationComposer } from "./controller";
import type { ActiveRecorder } from "./recorder";

const ENV = EnvironmentId.make("env-1");
const ONE_SECOND = new Int16Array(DICTATION_SAMPLE_RATE).fill(1000);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function ready(): DictationStatus {
  return { model: { state: "ready" }, last: null };
}

class FakeRecorder implements ActiveRecorder {
  stopped = false;
  cancelled = false;
  constructor(private readonly samples: Int16Array = ONE_SECOND) {}
  stop() {
    this.stopped = true;
    return this.samples;
  }
  cancel() {
    this.cancelled = true;
  }
  readLevel() {
    return 0.5;
  }
  sampleCount() {
    return this.samples.length;
  }
}

function harness(options: { readonly samples?: Int16Array; readonly maxSeconds?: number } = {}) {
  const transcribe = vi.fn(
    async (
      _env: EnvironmentId,
      _pcm: Uint8Array,
    ): Promise<DictationResult<{ text: string; raw: string }>> => ({
      ok: true,
      value: { text: "hello world", raw: "hello world" },
    }),
  );
  const status = vi.fn(async (): Promise<DictationResult<DictationStatus>> => ({
    ok: true,
    value: ready(),
  }));
  const downloadModel = vi.fn(async (): Promise<DictationResult<void>> => ({
    ok: true,
    value: undefined,
  }));
  const api: DictationApi = { status, downloadModel, transcribe };
  const recorders: Array<FakeRecorder> = [];
  const startRecorder = vi.fn(async () => {
    const recorder = new FakeRecorder(options.samples);
    recorders.push(recorder);
    return recorder;
  });
  const errors: Array<{ title: string; description: string }> = [];
  const controller = new DictationController({
    api,
    startRecorder,
    notifyError: (title, description) => errors.push({ title, description }),
    ...(options.maxSeconds === undefined ? {} : { maxSeconds: options.maxSeconds }),
  });
  const phases: Array<string> = [];
  controller.subscribe(() => {
    const phase = controller.getState().phase;
    if (phases[phases.length - 1] !== phase) phases.push(phase);
  });
  return {
    controller,
    api,
    status,
    downloadModel,
    transcribe,
    startRecorder,
    recorders,
    errors,
    phases,
  };
}

function composer(overrides: Partial<DictationComposer> = {}) {
  const inserted: Array<string> = [];
  const appended: Array<string> = [];
  const entry: DictationComposer = {
    environmentId: ENV,
    insertAtCursor: (text) => {
      inserted.push(text);
      return true;
    },
    appendToDraft: (text) => {
      appended.push(text);
      return true;
    },
    ...overrides,
  };
  return { entry, inserted, appended };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DictationController", () => {
  it("records, transcribes and inserts at the cursor of the composer it started in", async () => {
    const h = harness();
    const a = composer();
    h.controller.registerComposer("a", a.entry);

    h.controller.toggle("a");
    await flush();
    expect(h.controller.getState()).toMatchObject({ phase: "recording", ownerKey: "a" });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.controller.getState()).toMatchObject({ elapsedSeconds: 2, level: 0.5 });

    h.controller.toggle("a");
    expect(h.controller.getState()).toMatchObject({ phase: "transcribing", ownerKey: "a" });
    await flush();

    expect(h.transcribe).toHaveBeenCalledTimes(1);
    const [env, pcm] = h.transcribe.mock.calls[0]!;
    expect(env).toBe(ENV);
    expect(pcm.byteLength).toBe(ONE_SECOND.byteLength);
    expect(a.inserted).toEqual(["hello world"]);
    expect(a.appended).toEqual([]);
    expect(h.controller.getState().phase).toBe("idle");
    expect(h.phases).toEqual(["recording", "transcribing", "idle"]);
    expect(h.errors).toEqual([]);
  });

  it("downloads a missing model first, showing percent, then records", async () => {
    const h = harness();
    const download = deferred<DictationResult<void>>();
    let percent = 0;
    h.status.mockImplementation(async () => ({
      ok: true,
      value: {
        model: percent === 0 ? { state: "missing" } : { state: "downloading", percent },
        last: null,
      },
    }));
    h.downloadModel.mockImplementation(() => download.promise);
    h.controller.registerComposer("a", composer().entry);

    h.controller.toggle("a");
    await flush();
    expect(h.controller.getState()).toEqual({ phase: "downloading", ownerKey: "a", percent: 0 });
    expect(h.downloadModel).toHaveBeenCalledTimes(1);
    expect(h.startRecorder).not.toHaveBeenCalled();

    percent = 42;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.controller.getState()).toMatchObject({ phase: "downloading", percent: 42 });

    download.resolve({ ok: true, value: undefined });
    await flush();
    expect(h.controller.getState()).toMatchObject({ phase: "recording", ownerKey: "a" });
    expect(h.phases).toEqual(["downloading", "recording"]);
  });

  it("stops at the five-minute cap and transcribes what it captured", async () => {
    const h = harness();
    const a = composer();
    h.controller.registerComposer("a", a.entry);
    h.controller.toggle("a");
    await flush();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 - 1);
    expect(h.controller.getState().phase).toBe("recording");
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.recorders[0]!.stopped).toBe(true);
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(a.inserted).toEqual(["hello world"]);
    expect(h.controller.getState().phase).toBe("idle");
  });

  it("cancel discards the audio without uploading", async () => {
    const h = harness();
    h.controller.registerComposer("a", composer().entry);
    h.controller.toggle("a");
    await flush();

    h.controller.cancel();
    expect(h.recorders[0]!.cancelled).toBe(true);
    expect(h.controller.getState().phase).toBe("idle");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.phases).toEqual(["recording", "idle"]);
  });

  it("starting from another composer stops the current recording and transcribes it there", async () => {
    const h = harness();
    const a = composer();
    const b = composer();
    h.controller.registerComposer("a", a.entry);
    h.controller.registerComposer("b", b.entry);
    h.controller.toggle("a");
    await flush();

    h.controller.toggle("b");
    expect(h.controller.getState()).toMatchObject({ phase: "transcribing", ownerKey: "a" });
    await flush();
    expect(h.startRecorder).toHaveBeenCalledTimes(1);
    expect(a.inserted).toEqual(["hello world"]);
    expect(b.inserted).toEqual([]);
    expect(h.controller.getState().phase).toBe("idle");
  });

  it("ignores toggles while downloading or transcribing", async () => {
    const h = harness();
    const transcript = deferred<DictationResult<{ text: string; raw: string }>>();
    h.transcribe.mockImplementation(() => transcript.promise);
    h.controller.registerComposer("a", composer().entry);
    h.controller.toggle("a");
    await flush();
    h.controller.toggle("a");
    expect(h.controller.getState().phase).toBe("transcribing");
    h.controller.toggle("a");
    await flush();
    expect(h.startRecorder).toHaveBeenCalledTimes(1);
    transcript.resolve({ ok: true, value: { text: "x", raw: "x" } });
    await flush();
    expect(h.controller.getState().phase).toBe("idle");
  });

  it("a thread switch stops the recording and appends the text to that thread's draft", async () => {
    const h = harness();
    const a = composer();
    const unregister = h.controller.registerComposer("a", a.entry);
    h.controller.toggle("a");
    await flush();

    unregister();
    expect(h.controller.getState()).toMatchObject({ phase: "transcribing", ownerKey: "a" });
    await flush();
    expect(a.inserted).toEqual([]);
    expect(a.appended).toEqual(["hello world"]);
    expect(h.controller.getState().phase).toBe("idle");
  });

  it("inserts at the cursor when the same thread is mounted again by the time the text lands", async () => {
    const h = harness();
    const first = composer();
    const unregister = h.controller.registerComposer("a", first.entry);
    h.controller.toggle("a");
    await flush();
    unregister();
    const second = composer();
    h.controller.registerComposer("a", second.entry);
    await flush();
    expect(second.inserted).toEqual(["hello world"]);
    expect(first.appended).toEqual([]);
  });

  it("falls back to the draft when the live composer refuses the insert", async () => {
    const h = harness();
    const a = composer({ insertAtCursor: () => false });
    h.controller.registerComposer("a", a.entry);
    h.controller.toggle("a");
    await flush();
    h.controller.toggle("a");
    await flush();
    expect(a.appended).toEqual(["hello world"]);
    expect(h.errors).toEqual([]);
  });

  it("reports when neither the composer nor the draft can take the text", async () => {
    const h = harness();
    const a = composer({ insertAtCursor: () => false, appendToDraft: () => false });
    h.controller.registerComposer("a", a.entry);
    h.controller.toggle("a");
    await flush();
    h.controller.toggle("a");
    await flush();
    expect(h.errors).toEqual([
      { title: "Dictated text could not be placed", description: "hello world" },
    ]);
  });

  it("shows the server's reason when transcription fails and inserts nothing", async () => {
    const h = harness();
    h.transcribe.mockResolvedValue({
      ok: false,
      error: "Audio must be non-empty 16 kHz mono 16-bit PCM.",
    });
    const a = composer();
    h.controller.registerComposer("a", a.entry);
    h.controller.toggle("a");
    await flush();
    h.controller.toggle("a");
    await flush();
    expect(a.inserted).toEqual([]);
    expect(a.appended).toEqual([]);
    expect(h.errors).toEqual([
      { title: "Dictation failed", description: "Audio must be non-empty 16 kHz mono 16-bit PCM." },
    ]);
    expect(h.controller.getState().phase).toBe("idle");
  });

  it("shows the browser's reason when the microphone cannot be opened", async () => {
    const h = harness();
    const denied = new Error("Permission denied");
    denied.name = "NotAllowedError";
    h.startRecorder.mockRejectedValueOnce(denied);
    h.controller.registerComposer("a", composer().entry);
    h.controller.toggle("a");
    await flush();
    expect(h.errors).toEqual([
      { title: "Microphone unavailable", description: "NotAllowedError: Permission denied" },
    ]);
    expect(h.controller.getState().phase).toBe("idle");
  });

  it("skips the upload for a stray click shorter than a quarter second", async () => {
    const h = harness({ samples: new Int16Array(1_000) });
    h.controller.registerComposer("a", composer().entry);
    h.controller.toggle("a");
    await flush();
    h.controller.toggle("a");
    await flush();
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.controller.getState().phase).toBe("idle");
  });

  it("toggle without a key targets the most recently mounted composer", async () => {
    const h = harness();
    const a = composer();
    const b = composer();
    h.controller.registerComposer("a", a.entry);
    h.controller.registerComposer("b", b.entry);
    h.controller.toggle();
    await flush();
    expect(h.controller.getState()).toMatchObject({ phase: "recording", ownerKey: "b" });
  });

  it("does nothing when no composer is mounted", async () => {
    const h = harness();
    h.controller.toggle();
    await flush();
    expect(h.status).not.toHaveBeenCalled();
    expect(h.controller.getState().phase).toBe("idle");
  });
});
