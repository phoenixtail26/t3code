// Fork feature: dictation. The renderer half of the desktop global stop. The
// main process holds the system-wide chord only while no T3 Code window is
// focused (a held key takes the keystroke before the in-app keybinding can
// see it) and forwards each press here. The focus check below is a cheap
// backstop for a press that races a focus change. Unfocused, a press stops a
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
export class GlobalStopStatusStore {
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
