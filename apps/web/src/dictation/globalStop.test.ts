import { DICTATION_SAMPLE_RATE, EnvironmentId, type DictationStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DictationApi, DictationResult } from "./api";
import { DictationController, type DictationComposer } from "./controller";
import { dictationGlobalStopStatus, handleDictationGlobalStop } from "./globalStop";
import type { ActiveRecorder } from "./recorder";

const ENV = EnvironmentId.make("env-1");
const ONE_SECOND = new Int16Array(DICTATION_SAMPLE_RATE).fill(1000);

function ready(): DictationStatus {
  return { model: { state: "ready" }, file: { path: "/m", sizeBytes: 1 }, last: null };
}

function harness() {
  const transcribe = vi.fn(
    async (): Promise<DictationResult<{ text: string; raw: string }>> => ({
      ok: true,
      value: { text: "hello world", raw: "hello world" },
    }),
  );
  const api: DictationApi = {
    status: async () => ({ ok: true, value: ready() }),
    downloadModel: async () => ({ ok: true, value: undefined }),
    removeModel: async () => ({ ok: true, value: undefined }),
    transcribe,
  };
  const recorder: ActiveRecorder = {
    stop: () => ONE_SECOND,
    cancel: () => undefined,
    readLevel: () => 0,
    sampleCount: () => ONE_SECOND.length,
  };
  const startRecorder = vi.fn(async () => recorder);
  const controller = new DictationController({
    api,
    startRecorder,
    notifyError: () => undefined,
  });
  const inserted: Array<string> = [];
  const composer: DictationComposer = {
    environmentId: ENV,
    insertAtCursor: (text) => {
      inserted.push(text);
      return true;
    },
    appendToDraft: () => false,
  };
  controller.registerComposer("c1", composer);
  return { controller, startRecorder, transcribe, inserted };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("handleDictationGlobalStop", () => {
  it("ignores the press while the window is focused, even mid-recording", async () => {
    const h = harness();
    h.controller.toggle();
    await settle();
    expect(h.controller.getState().phase).toBe("recording");
    expect(handleDictationGlobalStop(h.controller, true)).toBe("ignored-focused");
    expect(h.controller.getState().phase).toBe("recording");
  });

  it("stops and transcribes a recording when the window is not focused", async () => {
    const h = harness();
    h.controller.toggle();
    await settle();
    expect(handleDictationGlobalStop(h.controller, false)).toBe("stopped");
    await settle();
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.inserted).toEqual(["hello world"]);
    expect(h.controller.getState().phase).toBe("idle");
  });

  it("never starts a dictation from the global event", async () => {
    const h = harness();
    expect(handleDictationGlobalStop(h.controller, false)).toBe("idle");
    await settle();
    expect(h.startRecorder).not.toHaveBeenCalled();
    expect(h.controller.getState().phase).toBe("idle");
  });
});

describe("dictationGlobalStopStatus", () => {
  it("notifies only when the result changes", () => {
    const listener = vi.fn();
    const unsubscribe = dictationGlobalStopStatus.subscribe(listener);
    dictationGlobalStopStatus.set({ registered: false, message: null });
    expect(listener).not.toHaveBeenCalled();
    dictationGlobalStopStatus.set({ registered: false, message: "taken" });
    dictationGlobalStopStatus.set({ registered: false, message: "taken" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(dictationGlobalStopStatus.getState().message).toBe("taken");
    dictationGlobalStopStatus.set({ registered: true, message: null });
    unsubscribe();
  });
});
