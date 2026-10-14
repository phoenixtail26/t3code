// Fork feature: dictation. Mounted once at the root in the desktop shell:
// pushes the effective `composer.dictate` chord (or null when the Voice
// toggle is off) to the main process whenever either changes, and turns the
// forwarded presses into a stop. Renders nothing; a no-op outside Electron.
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useSyncExternalStore } from "react";

import { usePrimarySettings } from "../hooks/useSettings";
import { effectiveShortcutsForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { dictationGlobalStopStatus, handleDictationGlobalStop } from "./globalStop";
import { dictation } from "./useDictation";

export const DICTATION_GLOBAL_STOP_DEFAULT = true;

export function useDictationGlobalStopEnabled(): boolean {
  return usePrimarySettings((settings) => settings.dictationGlobalStop ?? DICTATION_GLOBAL_STOP_DEFAULT);
}

export function useDictationGlobalStopStatus() {
  return useSyncExternalStore(
    dictationGlobalStopStatus.subscribe,
    dictationGlobalStopStatus.getState,
    dictationGlobalStopStatus.getState,
  );
}

export function DictationGlobalStopCoordinator() {
  const bridge = window.desktopBridge?.dictation;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const enabled = useDictationGlobalStopEnabled();
  const shortcut = effectiveShortcutsForCommand(keybindings, "composer.dictate")[0] ?? null;
  // The shortcut object is rebuilt each render; its serialized form is the dependency.
  const shortcutKey = shortcut === null ? null : JSON.stringify(shortcut);

  useEffect(() => {
    if (bridge === undefined) return;
    let cancelled = false;
    const next = enabled && shortcutKey !== null ? JSON.parse(shortcutKey) : null;
    void bridge.setGlobalStop(next).then((result) => {
      if (!cancelled) dictationGlobalStopStatus.set(result);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, enabled, shortcutKey]);

  useEffect(() => {
    if (bridge === undefined) return;
    return bridge.onGlobalStop(() => {
      handleDictationGlobalStop(dictation, document.hasFocus());
    });
  }, [bridge]);

  return null;
}
