import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { composerTargetKey } from "../composerDraftStore";
import { act, render } from "../../test/render";
import type { DictationState } from "./controller";

const h = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    state: { phase: "idle" } as { phase: string },
    listeners,
    toggle: vi.fn(),
    cancel: vi.fn(),
    emit(next: object) {
      h.state = next as { phase: string };
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("./useDictation", () => {
  const dictation = {
    getState: () => h.state as DictationState,
    subscribe: (listener: () => void) => {
      h.listeners.add(listener);
      return () => h.listeners.delete(listener);
    },
    registerComposer: () => () => {},
    toggle: (...args: unknown[]) => h.toggle(...args),
    cancel: () => h.cancel(),
  };
  return {
    dictation,
    useDictationState: () =>
      useSyncExternalStore(dictation.subscribe, dictation.getState, dictation.getState),
  };
});

import { DictationButton } from "./DictationButton";

const target = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const ownerKey = composerTargetKey(target);

// The mocked dictation store is module state; leave it idle with no listeners or calls.
function resetDictationMock(): Disposable {
  const reset = () => {
    h.state = { phase: "idle" };
    h.listeners.clear();
    h.toggle.mockReset();
  };
  reset();
  return { [Symbol.dispose]: reset };
}

function renderButton() {
  const container = document.createElement("div");
  container.id = "composer";
  return render(
    <DictationButton
      target={target}
      environmentId={target.environmentId}
      insertTextAtCursor={() => true}
    />,
    { container, router: false },
  );
}

function mountTextarea() {
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  return Object.assign(textarea, { [Symbol.dispose]: () => textarea.remove() });
}

const inComposer = (testId: string) =>
  document.querySelector(`#composer [data-testid="${testId}"]`);
const floating = () => document.querySelector('[data-testid="dictation-floating-pill"]');

function fieldState(phase: "recording" | "transcribing", element: HTMLElement, inline = false) {
  const base = {
    ownerKey,
    field: { target: { element, insertAtSelection: () => true }, inline },
  };
  return phase === "recording"
    ? { ...base, phase, elapsedSeconds: 3, level: 0.4 }
    : { ...base, phase };
}

describe("DictationButton", () => {
  it("shows the button when idle and the in-place pill for its own composer dictation", async () => {
    using _reset = resetDictationMock();
    await using _screen = await renderButton();
    expect(inComposer("dictation-button")).not.toBeNull();
    expect(inComposer("dictation-pill")).toBeNull();
    expect(floating()).toBeNull();

    await act(async () => h.emit({ phase: "recording", ownerKey, elapsedSeconds: 1, level: 0.5 }));
    expect(inComposer("dictation-button")).toBeNull();
    expect(inComposer("dictation-pill")?.getAttribute("data-dictation-phase")).toBe("recording");
    expect(floating()).toBeNull();
  });

  it("floats the pill beside a field while a field dictation runs, then removes it", async () => {
    using _reset = resetDictationMock();
    using textarea = mountTextarea();
    textarea.getBoundingClientRect = () =>
      ({ top: 300, bottom: 340, left: 100, right: 400 }) as DOMRect;
    await using _screen = await renderButton();

    await act(async () => h.emit(fieldState("recording", textarea)));
    const pill = floating();
    expect(pill).not.toBeNull();
    expect(pill?.closest("#composer")).toBeNull();
    expect(inComposer("dictation-pill")).toBeNull();
    expect(inComposer("dictation-button")).not.toBeNull();
    expect((pill as HTMLElement).style.top).toBe("296px");
    expect((pill as HTMLElement).style.left).toBe("400px");
    expect(pill?.querySelector('[data-dictation-phase="recording"]')).not.toBeNull();

    await act(async () => h.emit(fieldState("transcribing", textarea)));
    expect(floating()?.querySelector('[data-dictation-phase="transcribing"]')).not.toBeNull();

    await act(async () => h.emit({ phase: "idle" }));
    expect(floating()).toBeNull();
    expect(inComposer("dictation-button")).not.toBeNull();
  });

  it("leaves the floating pill out when the field has its own button", async () => {
    using _reset = resetDictationMock();
    using textarea = mountTextarea();
    await using _screen = await renderButton();
    await act(async () => h.emit(fieldState("recording", textarea, true)));
    expect(floating()).toBeNull();
    expect(inComposer("dictation-pill")).toBeNull();
  });

  it("does not float a pill for another composer's field dictation", async () => {
    using _reset = resetDictationMock();
    using textarea = mountTextarea();
    await using _screen = await renderButton();
    await act(async () => h.emit({ ...fieldState("recording", textarea), ownerKey: "other" }));
    expect(floating()).toBeNull();
  });

  it("stopping from the floating pill toggles this composer's dictation", async () => {
    using _reset = resetDictationMock();
    using textarea = mountTextarea();
    await using _screen = await renderButton();
    await act(async () => h.emit(fieldState("recording", textarea)));
    const stop = floating()?.querySelector<HTMLButtonElement>('[data-testid="dictation-pill"]');
    await act(async () => stop!.click());
    expect(h.toggle).toHaveBeenCalledWith(ownerKey);
  });
});
