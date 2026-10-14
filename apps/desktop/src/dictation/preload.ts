// Fork feature: dictation. The preload half of the global stop: one invoke to
// set the chord and one event when it is pressed. Mounted as
// `desktopBridge.dictation` by preload.ts.
import type { DesktopDictationBridge } from "@t3tools/contracts";
import type { IpcRenderer } from "electron";

import {
  DICTATION_GLOBAL_STOP_EVENT_CHANNEL,
  SET_DICTATION_GLOBAL_STOP_CHANNEL,
} from "./channels.ts";

export function makeDictationPreloadBridge(ipcRenderer: IpcRenderer): DesktopDictationBridge {
  return {
    setGlobalStop: (shortcut) => ipcRenderer.invoke(SET_DICTATION_GLOBAL_STOP_CHANNEL, shortcut),
    onGlobalStop: (listener) => {
      const wrappedListener = () => listener();
      ipcRenderer.on(DICTATION_GLOBAL_STOP_EVENT_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(DICTATION_GLOBAL_STOP_EVENT_CHANNEL, wrappedListener);
      };
    },
  };
}
