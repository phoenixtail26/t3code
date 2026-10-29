import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  type DictationStatus,
  type UnifiedSettings,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import type { DictationResult } from "./api";
import type { DictationState } from "./controller";

const ENV = EnvironmentId.make("env-1");

const h = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    settings: null as UnifiedSettings | null,
    updateSettings: vi.fn(),
    status: vi.fn(),
    removeModel: vi.fn(),
    downloadModel: vi.fn(),
    phase: { phase: "idle" } as { phase: string },
    listeners,
    emit(next: { phase: string }) {
      h.phase = next;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("../hooks/useSettings", () => ({
  usePrimarySettings: () => h.settings,
  useUpdatePrimarySettings: () => h.updateSettings,
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: ENV }),
}));
vi.mock("./api", () => ({
  dictationApi: {
    status: (...args: unknown[]) => h.status(...args),
    removeModel: (...args: unknown[]) => h.removeModel(...args),
    downloadModel: (...args: unknown[]) => h.downloadModel(...args),
  },
}));
vi.mock("./useDictation", () => ({
  dictation: {
    getState: () => h.phase as DictationState,
    subscribe: (listener: () => void) => {
      h.listeners.add(listener);
      return () => h.listeners.delete(listener);
    },
  },
}));
// SettingsRow reads environment, scope and permission state through many
// hooks; the section's behaviour does not depend on any of it.
vi.mock("../components/settings/settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: (props: {
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    resetAction?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      <h3>{props.title}</h3>
      <p>{props.description}</p>
      {props.status}
      {props.resetAction}
      {props.control}
      {props.children}
    </div>
  ),
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" aria-label={`Reset ${label} to default`} onClick={onClick} />
  ),
}));

import { VoiceSettingsSection } from "./VoiceSettingsSection";

const FILE = { path: "C:\\t3\\models\\dictation\\parakeet.gguf", sizeBytes: 729_574_912 };
const statusOf = (
  model: DictationStatus["model"],
  last: DictationStatus["last"] = null,
): DictationResult<DictationStatus> => ({ ok: true, value: { model, file: FILE, last } });

const renderSection = () => render(<VoiceSettingsSection />, { router: false });

const byLabel = <T extends HTMLElement>(label: string) => {
  const element = document.querySelector<T>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`No element labelled ${label}`);
  return element;
};
const buttonNamed = (name: string) => {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) throw new Error(`No button named ${name}`);
  return button;
};
// The mocks are module state; each test starts from defaults and leaves them behind.
function resetMocks(): Disposable {
  const reset = () => {
    h.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      dictation: { fillerCleanup: true, dictionary: "" },
    };
    h.updateSettings.mockReset();
    h.status.mockReset().mockResolvedValue(statusOf({ state: "ready" }));
    h.removeModel.mockReset().mockResolvedValue({ ok: true, value: undefined });
    h.downloadModel.mockReset().mockResolvedValue({ ok: true, value: undefined });
    h.phase = { phase: "idle" };
    h.listeners.clear();
  };
  reset();
  return { [Symbol.dispose]: reset };
}
const click = (element: HTMLElement) => act(async () => element.click());

describe("VoiceSettingsSection", () => {
  it("writes fillerCleanup through the settings patch", async () => {
    using _mocks = resetMocks();
    await using _screen = await renderSection();
    await click(byLabel("Filler cleanup"));
    expect(h.updateSettings).toHaveBeenCalledWith({ dictation: { fillerCleanup: false } });
  });

  it("commits the dictionary text as one string on blur, and only when it changed", async () => {
    using _mocks = resetMocks();
    h.settings = { ...h.settings!, dictation: { fillerCleanup: true, dictionary: "a => b" } };
    await using _screen = await renderSection();
    const textarea = byLabel<HTMLTextAreaElement>("Dictionary");
    expect(textarea.value).toBe("a => b");

    await act(async () => {
      textarea.focus();
      textarea.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    await act(async () => {
      textarea.blur();
      textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(h.updateSettings).not.toHaveBeenCalled();

    await act(async () => {
      textarea.focus();
      textarea.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(textarea, "a => b\ntee three => T3");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(h.updateSettings).not.toHaveBeenCalled();
    await act(async () => {
      textarea.blur();
      textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(h.updateSettings).toHaveBeenCalledWith({
      dictation: { dictionary: "a => b\ntee three => T3" },
    });
  });

  it("shows the last transcription's raw and cleaned text from the status", async () => {
    using _mocks = resetMocks();
    h.status.mockResolvedValue(
      statusOf({ state: "ready" }, { raw: "Um, T3 code is great.", text: "T3 Code is great." }),
    );
    await using _screen = await renderSection();
    const cells = Array.from(document.querySelectorAll("dd")).map((cell) => cell.textContent);
    expect(cells).toEqual(["Um, T3 code is great.", "T3 Code is great."]);
    expect(document.body.textContent).toContain(FILE.path);
    expect(document.body.textContent).toContain("696 MB");
  });

  it("removes the model after confirmation and re-reads the status", async () => {
    using _mocks = resetMocks();
    await using _screen = await renderSection();
    await click(buttonNamed("Remove"));
    expect(h.removeModel).not.toHaveBeenCalled();
    const confirm = Array.from(document.querySelectorAll("[role=alertdialog] button")).find(
      (button) => button.textContent?.trim() === "Remove",
    ) as HTMLButtonElement | undefined;
    if (!confirm) throw new Error("No confirm button in the dialog");
    h.status.mockResolvedValue(statusOf({ state: "missing" }));
    await click(confirm);
    expect(h.removeModel).toHaveBeenCalledWith(ENV);
    expect(h.status).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("not downloaded");
    expect(() => buttonNamed("Download")).not.toThrow();
  });

  it("keeps Remove available during a download started here, so it can cancel it", async () => {
    using _mocks = resetMocks();
    h.status.mockResolvedValue(statusOf({ state: "missing" }));
    h.downloadModel.mockImplementation(() => new Promise(() => {}));
    await using _screen = await renderSection();
    h.status.mockResolvedValue(statusOf({ state: "downloading", percent: 12 }));
    await click(buttonNamed("Download"));
    expect(h.downloadModel).toHaveBeenCalledWith(ENV);
    expect(document.body.textContent).toContain("12%");

    const remove = buttonNamed("Remove");
    expect(remove.disabled).toBe(false);
    await click(remove);
    const confirm = Array.from(document.querySelectorAll("[role=alertdialog] button")).find(
      (button) => button.textContent?.trim() === "Remove",
    ) as HTMLButtonElement | undefined;
    if (!confirm) throw new Error("No confirm button in the dialog");
    h.removeModel.mockImplementation(() => new Promise(() => {}));
    await click(confirm);
    expect(h.removeModel).toHaveBeenCalledWith(ENV);
    expect(buttonNamed("Remove").disabled).toBe(true);
  });

  it("re-reads the status when a dictation finishes", async () => {
    using _mocks = resetMocks();
    await using _screen = await renderSection();
    expect(h.status).toHaveBeenCalledTimes(1);
    await act(async () => h.emit({ phase: "recording" }));
    await act(async () => h.emit({ phase: "transcribing" }));
    expect(h.status).toHaveBeenCalledTimes(1);
    h.status.mockResolvedValue(statusOf({ state: "ready" }, { raw: "hello hello", text: "hello" }));
    await act(async () => h.emit({ phase: "idle" }));
    expect(h.status).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("hello hello");
  });
});
