// Fork additions to upstream's ThreadNotificationCoordinator. The coordinator
// owns detection and delivery; this module supplies the three behaviours the
// fork's retired notifier had that upstream lacks, each mounted there as a
// one-line call (see AGENTS.md, "Fork additions").
import type { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { getClientSettings } from "../hooks/useSettings";
import { playNotificationSound as playSoundFile } from "../lib/notificationSound";
import {
  playNotificationSound as playBundledNotificationSound,
  unlockNotificationAudio,
} from "../threadNotifications";

/**
 * How long a thread must stay completed before its finish alert fires. An
 * agent taking another step dips through "completed" between turns (idle,
 * then the next turn starts) well inside this window, so step boundaries stay
 * quiet; a real finish alerts after the delay. Blocking states (input,
 * approval, failure) are stable and still alert immediately.
 */
export const COMPLETION_DEBOUNCE_MS = 10_000;

export interface CompletionDebounce {
  /**
   * True once `key`'s completion has held for the window, consuming the flag
   * so the caller delivers exactly once. Otherwise arms the timer (if not
   * already armed) and returns false; the caller should leave its recorded
   * completion unchanged so the next pass still sees a fresh finish.
   */
  readonly ready: (key: ThreadId) => boolean;
  /** The thread resumed work or left; drop any pending or settled completion. */
  readonly cancel: (key: ThreadId) => void;
}

/**
 * Completion hold for the coordinator's per-environment effect. When a timer
 * expires the hook publishes a new gate identity, which re-runs that effect
 * (it lists the gate as a dependency) so delivery happens with current
 * settings and focus.
 */
export function useCompletionDebounce(): CompletionDebounce {
  const timers = useRef(new Map<ThreadId, ReturnType<typeof setTimeout>>());
  const settled = useRef(new Set<ThreadId>());
  // Filled by the effect below; timers fire long after mount, so the callback
  // never runs before it is set. Keeps the state setter out of its own
  // initializer.
  const publish = useRef<() => void>(() => {});
  const [gate, setGate] = useState<CompletionDebounce>(() => {
    const initial: CompletionDebounce = {
      ready: (key) => {
        if (settled.current.delete(key)) return true;
        if (!timers.current.has(key)) {
          timers.current.set(
            key,
            setTimeout(() => {
              timers.current.delete(key);
              settled.current.add(key);
              publish.current();
            }, COMPLETION_DEBOUNCE_MS),
          );
        }
        return false;
      },
      cancel: (key) => {
        const timer = timers.current.get(key);
        if (timer !== undefined) {
          clearTimeout(timer);
          timers.current.delete(key);
        }
        settled.current.delete(key);
      },
    };
    return initial;
  });

  useEffect(() => {
    // A fresh identity per expiry is what re-runs the coordinator effect.
    publish.current = () => setGate((current) => ({ ...current }));
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return gate;
}

/**
 * Open a thread from a system notification click. In Electron the renderer's
 * `window.focus()` cannot restore a minimized window or take foreground on
 * Windows; the main process can. Client-side navigation lazily imports the
 * route chunk, and if a rebuild replaced dist under the running app that
 * import rejects and the click would silently do nothing — fall back to a
 * full page load, which fetches the current shell.
 */
export function openThreadFromNotification(
  navigate: ReturnType<typeof useNavigate>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): void {
  void window.desktopBridge?.focusMainWindow?.();
  window.focus();
  void Promise.resolve(
    navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } }),
  ).catch(() => {
    window.location.assign(`/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`);
  });
}

/**
 * Drop-in for upstream's `playNotificationSound` that honours the fork's
 * per-device OS sound choice (`desktopNotificationSoundPath`). Empty means
 * upstream's bundled sounds.
 */
export async function playNotificationSound(
  kind: "completion" | "input",
  shouldPlay: () => boolean,
): Promise<void> {
  const soundPath = getClientSettings().desktopNotificationSoundPath;
  if (!soundPath) return playBundledNotificationSound(kind, shouldPlay);
  if (!shouldPlay()) return;
  await playSoundFile(soundPath);
}

/** Settings preview: the chosen OS sound, or upstream's completion sound. */
export async function previewNotificationSound(soundPath: string): Promise<boolean> {
  if (soundPath.length === 0) {
    unlockNotificationAudio();
    await playBundledNotificationSound("completion", () => true);
    return true;
  }
  return playSoundFile(soundPath);
}
