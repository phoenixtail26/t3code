// Fork feature: dictation. Mounted once at the root in the desktop shell:
// pushes the effective `composer.dictate` chord (or null when the Voice
// toggle is off) to the main process whenever either changes, and turns the
// forwarded presses into a stop. Renders nothing; a no-op outside Electron.
import { useAtomValue } from "@effect/atom-react";
import type { KeybindingShortcut } from "@t3tools/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";

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
  // Context-free resolution: a user binding whose `when` clause is false in
  // the default context resolves to null here and releases the key, so the
  // global stop follows only bindings that apply everywhere in the app.
  const resolved = effectiveShortcutsForCommand(keybindings, "composer.dictate")[0] ?? null;
  // The shortcut object is rebuilt each render; its serialized form is the dependency.
  const shortcutKey = resolved === null ? null : JSON.stringify(resolved);
  const shortcut = useMemo(
    () => (shortcutKey === null ? null : (JSON.parse(shortcutKey) as KeybindingShortcut)),
    [shortcutKey],
  );

  useEffect(() => {
    if (bridge === undefined) return;
    let cancelled = false;
    void bridge.setGlobalStop(enabled ? shortcut : null).then((result) => {
      if (!cancelled) dictationGlobalStopStatus.set(result);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, enabled, shortcut]);

  useEffect(() => {
    if (bridge === undefined) return;
    return bridge.onGlobalStop(() => {
      handleDictationGlobalStop(dictation, document.hasFocus());
    });
  }, [bridge]);

  return null;
}
