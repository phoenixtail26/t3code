import { EnvironmentId, type DictationStatus } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DictationResult } from "./api";
import { DictationModelStatusStore } from "./modelStatus";

const ENV = EnvironmentId.make("env-1");
const FILE = { path: "/t3/models/dictation/model.gguf", sizeBytes: 729_574_912 };

const status = (model: DictationStatus["model"]): DictationResult<DictationStatus> => ({
  ok: true,
  value: { model, file: FILE, last: null },
});

function harness(sequence: ReadonlyArray<DictationResult<DictationStatus>>) {
  const remaining = [...sequence];
  const statusFn = vi.fn(async (): Promise<DictationResult<DictationStatus>> =>
    remaining.length > 1 ? remaining.shift()! : remaining[0]!,
  );
  const downloadModel = vi.fn(async (): Promise<DictationResult<void>> => ({
    ok: true,
    value: undefined,
  }));
  const removeModel = vi.fn(async (): Promise<DictationResult<void>> => ({
    ok: true,
    value: undefined,
  }));
  const store = new DictationModelStatusStore({
    api: { status: statusFn, downloadModel, removeModel },
    pollMs: 100,
  });
  return { store, status: statusFn, downloadModel, removeModel };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("DictationModelStatusStore", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not poll when the model is ready or missing", async () => {
    const h = harness([status({ state: "ready" })]);
    await h.store.refresh(ENV);
    expect(h.store.getState().status?.model).toEqual({ state: "ready" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.status).toHaveBeenCalledTimes(1);

    const missing = harness([status({ state: "missing" })]);
    await missing.store.refresh(ENV);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(missing.status).toHaveBeenCalledTimes(1);
  });

  it("polls while downloading and stops once the model is ready", async () => {
    const h = harness([
      status({ state: "downloading", percent: 10 }),
      status({ state: "downloading", percent: 60 }),
      status({ state: "ready" }),
    ]);
    await h.store.refresh(ENV);
    expect(h.store.getState().status?.model).toEqual({ state: "downloading", percent: 10 });
    expect(h.status).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(h.store.getState().status?.model).toEqual({ state: "downloading", percent: 60 });
    expect(h.status).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(100);
    expect(h.store.getState().status?.model).toEqual({ state: "ready" });
    expect(h.status).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.status).toHaveBeenCalledTimes(3);
  });

  it("stops polling when disposed mid-download", async () => {
    const h = harness([status({ state: "downloading", percent: 10 })]);
    await h.store.refresh(ENV);
    h.store.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.status).toHaveBeenCalledTimes(1);
  });

  it("removes the model, then re-reads the status", async () => {
    const h = harness([status({ state: "ready" }), status({ state: "missing" })]);
    await h.store.refresh(ENV);
    const removal = h.store.removeModel(ENV);
    expect(h.store.getState().removing).toBe(true);
    await removal;
    expect(h.removeModel).toHaveBeenCalledWith(ENV);
    expect(h.store.getState()).toMatchObject({ removing: false, error: null });
    expect(h.store.getState().status?.model).toEqual({ state: "missing" });
  });

  it("keeps the route's error and clears it on the next success", async () => {
    const h = harness([status({ state: "ready" })]);
    h.removeModel.mockResolvedValueOnce({
      ok: false,
      error: "Removing the dictation model failed.",
    });
    await h.store.refresh(ENV);
    await h.store.removeModel(ENV);
    expect(h.store.getState().error).toBe("Removing the dictation model failed.");
    expect(h.store.getState().status?.model).toEqual({ state: "ready" });
    await h.store.removeModel(ENV);
    expect(h.store.getState().error).toBeNull();
  });

  it("ignores a second request while one is in flight", async () => {
    const h = harness([status({ state: "ready" })]);
    let finish!: (value: DictationResult<void>) => void;
    h.removeModel.mockImplementationOnce(
      () =>
        new Promise<DictationResult<void>>((resolve) => {
          finish = resolve;
        }),
    );
    const first = h.store.removeModel(ENV);
    await flush();
    void h.store.removeModel(ENV);
    expect(h.removeModel).toHaveBeenCalledTimes(1);
    finish({ ok: true, value: undefined });
    await first;
  });

  it("removes during its own download and does not report the cancellation", async () => {
    const h = harness([status({ state: "downloading", percent: 5 }), status({ state: "missing" })]);
    let finishDownload!: (value: DictationResult<void>) => void;
    h.downloadModel.mockImplementationOnce(
      () =>
        new Promise<DictationResult<void>>((resolve) => {
          finishDownload = resolve;
        }),
    );
    const download = h.store.downloadModel(ENV);
    await flush();
    expect(h.store.getState()).toMatchObject({ downloading: true, removing: false });

    const removal = h.store.removeModel(ENV);
    expect(h.removeModel).toHaveBeenCalledWith(ENV);
    finishDownload({ ok: false, error: "The dictation model download was cancelled." });
    await Promise.all([download, removal]);
    expect(h.store.getState()).toMatchObject({ downloading: false, removing: false, error: null });
    expect(h.store.getState().status?.model).toEqual({ state: "missing" });
  });
});
