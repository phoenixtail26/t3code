// Fork: acked server settings overlay, mounted in hooks/useSettings.ts. The
// server-config projection can stall after a WebSocket reconnect (FORK_ROADMAP.md
// #5), freezing atom-backed settings, so this holds the settings the last update
// RPC returned and merges them over the atom until a fresh projection value lands.
import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

const ackedServerSettings = new Map<EnvironmentId, ServerSettings>();
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setAckedServerSettings(
  environmentId: EnvironmentId,
  settings: ServerSettings,
): void {
  ackedServerSettings.set(environmentId, settings);
  emitChange();
}

/** Drops the overlay once the projection delivers `authoritative`, unless that
 *  is the very object we acked, in which case nothing is stale. */
function clearAckedServerSettings(
  environmentId: EnvironmentId,
  authoritative: ServerSettings,
): void {
  if (ackedServerSettings.get(environmentId) === authoritative) return;
  if (ackedServerSettings.delete(environmentId)) emitChange();
}

export function resetAckedServerSettingsForTests(): void {
  ackedServerSettings.clear();
  listeners.clear();
}

/**
 * The acked settings for `environmentId` while they are newer than the atom
 * value. A new `serverSettings` identity means the projection delivered fresh
 * authoritative settings; from then on the overlay would only mask newer
 * server truth, so it is dropped.
 */
export function useAckedServerSettings(
  environmentId: EnvironmentId | null,
  serverSettings: ServerSettings,
): ServerSettings | null {
  const acked = useSyncExternalStore(
    subscribe,
    () => (environmentId === null ? null : (ackedServerSettings.get(environmentId) ?? null)),
    () => null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retires the module-level overlay entry once the projection (outside React) delivers fresh settings
  useEffect(() => {
    if (environmentId !== null) clearAckedServerSettings(environmentId, serverSettings);
  }, [environmentId, serverSettings]);
  return acked;
}
