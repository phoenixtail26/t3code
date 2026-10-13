// Fork feature: dictation. The client-wide controller instance and the hook
// the button reads it through. `toggleDictation` is what the keybinding and
// the command palette call.
import { useSyncExternalStore } from "react";

import { toastManager } from "../components/ui/toast";
import { dictationApi } from "./api";
import { DictationController, type DictationState } from "./controller";
import { startMicrophoneRecorder } from "./recorder";

export const dictation = new DictationController({
  api: dictationApi,
  startRecorder: startMicrophoneRecorder,
  notifyError: (title, description) => {
    toastManager.add({ type: "error", title, description });
  },
});

export function useDictationState(): DictationState {
  return useSyncExternalStore(dictation.subscribe, dictation.getState, dictation.getState);
}

/** Start, or stop and transcribe, for the most recently mounted composer. */
export function toggleDictation(): void {
  dictation.toggle();
}
