// Fork feature: read aloud. The automatic read aloud setting, per device: it lives in this
// browser's storage, not in the server's settings, because the phone and the desktop each
// decide for themselves.
import { useSyncExternalStore } from "react";

export const READ_ALOUD_MODES = ["off", "dictated", "always"] as const;
export type ReadAloudMode = (typeof READ_ALOUD_MODES)[number];
export const DEFAULT_READ_ALOUD_MODE: ReadAloudMode = "dictated";

const STORAGE_KEY = "t3code:read-aloud:v1";
const listeners = new Set<() => void>();

function isMode(value: unknown): value is ReadAloudMode {
  return (READ_ALOUD_MODES as ReadonlyArray<unknown>).includes(value);
}

export function readReadAloudMode(): ReadAloudMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isMode(stored) ? stored : DEFAULT_READ_ALOUD_MODE;
  } catch {
    return DEFAULT_READ_ALOUD_MODE;
  }
}

export function setReadAloudMode(mode: ReadAloudMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch (error) {
    console.error("[read-aloud] Could not save the setting.", error);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useReadAloudMode(): ReadAloudMode {
  return useSyncExternalStore(subscribe, readReadAloudMode, () => DEFAULT_READ_ALOUD_MODE);
}
