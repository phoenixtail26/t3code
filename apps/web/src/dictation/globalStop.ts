// Fork feature: dictation. The renderer half of the desktop global stop. The
// main process forwards every press of the system-wide chord; this decides
// what it means. While the window is focused the in-app keybinding already
// handled the same keystroke, so the event is ignored. Unfocused, it stops a
// recording and transcribes it, and never starts one.
import type { DesktopDictationGlobalStopResult } from "@t3tools/contracts";

import type { DictationController } from "./controller";

export type GlobalStopOutcome = "ignored-focused" | "stopped" | "idle";

export function handleDictationGlobalStop(
  controller: Pick<DictationController, "getState" | "stopAndTranscribe">,
  windowFocused: boolean,
): GlobalStopOutcome {
  if (windowFocused) return "ignored-focused";
  if (controller.getState().phase !== "recording") return "idle";
  void controller.stopAndTranscribe();
  return "stopped";
}

/** The last registration result, for the Voice section's failure message. */
class GlobalStopStatusStore {
  readonly #listeners = new Set<() => void>();
  #state: DesktopDictationGlobalStopResult = { registered: false, message: null };

  getState = (): DesktopDictationGlobalStopResult => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  set(next: DesktopDictationGlobalStopResult): void {
    if (next.registered === this.#state.registered && next.message === this.#state.message) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}

export const dictationGlobalStopStatus = new GlobalStopStatusStore();
