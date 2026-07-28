import { projectThreadAwareness, type AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";

import { playNotificationSound } from "../lib/notificationSound";
import { useProjects, useThreadShells } from "../state/entities";
import { useClientSettings } from "./useSettings";
import { buildThreadRouteParams } from "../threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  classifyThreadTransitions,
  COMPLETION_DEBOUNCE_MS,
  type AttentionNotification,
  type ThreadAwarenessSnapshot,
} from "./threadAttention.logic";

/**
 * Native notifications for threads that need the user.
 *
 * Runs entirely in the renderer: inside Electron the Web Notification API is
 * delivered as a real Windows/macOS system notification, and in a browser (or
 * the phone PWA) it is an ordinary web notification — one implementation, every
 * surface. Phase detection reuses `@t3tools/shared/agentAwareness`, the same
 * ladder the server's ntfy bridge and the T3 Connect relay use, so all three
 * agree on what "needs attention" means.
 *
 * Deliberately quiet on two axes:
 *  - A notification only fires when this client is NOT focused (if you are
 *    looking at the app you can already see it), and only on a phase TRANSITION,
 *    so a thread parked at "waiting for approval" notifies once.
 *  - "Completed" is DEBOUNCED. A thread doing another step dips through
 *    "completed" between turns (the agent goes idle, then the next turn starts),
 *    which would otherwise fire a false "agent finished" toast on every step.
 *    Completion toasts wait out {@link COMPLETION_DEBOUNCE_MS}; if the thread
 *    resumes work in that window the toast is cancelled. Blocking phases
 *    (approval/input/failed) still fire immediately — they are stable states.
 */

export function useThreadAttentionNotifications(): void {
  const threadShells = useThreadShells();
  const projects = useProjects();
  const navigate = useNavigate();
  const notificationsEnabled = useClientSettings<boolean>(
    (settings) => settings.desktopNotificationsEnabled,
  );
  const soundEnabled = useClientSettings<boolean>((settings) => settings.desktopNotificationSound);
  const soundPath = useClientSettings<string>((settings) => settings.desktopNotificationSoundPath);
  const lastPhaseByThreadRef = useRef(new Map<string, AgentAwarenessPhase>());
  // Per-thread timers for completions awaiting the debounce window.
  const completionTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Delivered notifications still on screen, keyed by thread. Held only to keep
  // them from being garbage collected while the user can still click them.
  const liveNotificationsRef = useRef(new Map<string, Notification>());
  // Seeded on the first pass so a client that starts up with threads already
  // waiting/completed does not fire a burst of notifications for pre-existing
  // state.
  const seededRef = useRef(false);
  // Alerts raised since the user was last here. The taskbar reflects "you have
  // not seen this yet", not "a thread is currently blocked" — a run that
  // finished while you were away is exactly what the badge is for, and in
  // full-access mode completion is the only phase a thread ever reaches.
  const hasUnseenAlertsRef = useRef(false);

  const openThread = useCallback(
    (environmentId: string, threadId: string) => {
      // In Electron the renderer's `window.focus()` cannot restore a minimized
      // window or take foreground on Windows; the main process can.
      void window.desktopBridge?.focusMainWindow?.();
      window.focus();
      const params = buildThreadRouteParams(
        scopeThreadRef(environmentId as never, threadId as never),
      );
      // Client-side navigation lazily imports the thread route's chunk. If that
      // chunk is gone (a rebuild replaced dist under the running app) the import
      // rejects, and an unhandled rejection here would silently swallow the
      // click — the window foregrounds but never opens the thread. Fall back to
      // a full page load, which fetches the current shell and its chunks.
      navigate({ to: "/$environmentId/$threadId", params }).catch(() => {
        window.location.assign(
          `/${encodeURIComponent(params.environmentId)}/${encodeURIComponent(params.threadId)}`,
        );
      });
    },
    [navigate],
  );

  const deliverItems = useCallback(
    (items: readonly AttentionNotification[]) => {
      // Focused means the user can already see the thread list; stay silent.
      if (!notificationsEnabled || items.length === 0 || document.hasFocus()) return;
      // The taskbar marks unseen work even when the OS suppresses the toast
      // (permission denied, focus assist), so it is set before delivery.
      hasUnseenAlertsRef.current = true;
      void window.desktopBridge?.setAttentionState?.({ waiting: !document.hasFocus() });
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

      let played = false;
      const live = liveNotificationsRef.current;
      for (const item of items) {
        const notification = new Notification(item.title, {
          body: item.body,
          // Re-notifying the same thread replaces its previous toast instead of
          // stacking duplicates.
          tag: item.key,
        });
        // Hold a reference until the toast is done. A Notification with no
        // strong JS reference can be garbage collected, and the browser then has
        // nothing to dispatch "click" to — the toast still shows in the OS but
        // clicking it does nothing. Delivery happens from a debounce timer, so
        // there is no other live reference to keep it alive.
        live.get(item.key)?.close();
        live.set(item.key, notification);
        const release = () => {
          if (live.get(item.key) === notification) live.delete(item.key);
        };
        notification.addEventListener("close", release, { once: true });
        notification.addEventListener("error", release, { once: true });
        notification.addEventListener(
          "click",
          () => {
            release();
            notification.close();
            openThread(item.environmentId, item.threadId);
          },
          { once: true },
        );
        if (soundEnabled && !played) {
          // One sound per batch, however many threads transitioned at once.
          played = true;
          void playNotificationSound(soundPath);
        }
      }
    },
    [notificationsEnabled, openThread, soundEnabled, soundPath],
  );

  // A latest-value ref so a completion timer armed in an earlier render still
  // delivers with current settings when it fires.
  const deliverRef = useRef(deliverItems);
  useEffect(() => {
    deliverRef.current = deliverItems;
  }, [deliverItems]);

  useEffect(() => {
    const projectTitleById = new Map(projects.map((project) => [project.id, project.title]));
    const snapshots: ThreadAwarenessSnapshot[] = [];
    for (const shell of threadShells) {
      const projectTitle = projectTitleById.get(shell.projectId);
      if (projectTitle === undefined) continue;
      const state = projectThreadAwareness({
        environmentId: shell.environmentId,
        project: { title: projectTitle },
        thread: shell,
      });
      if (state === null) continue;
      snapshots.push({
        key: `${shell.environmentId} ${shell.id}`,
        environmentId: shell.environmentId,
        threadId: shell.id,
        phase: state.phase,
        title: `${state.headline}: ${state.threadTitle}`,
        body: state.detail ? `${projectTitle} · ${state.detail}` : projectTitle,
      });
    }

    const timers = completionTimersRef.current;
    const result = classifyThreadTransitions({
      previousPhases: lastPhaseByThreadRef.current,
      snapshots,
      seeded: seededRef.current,
    });
    lastPhaseByThreadRef.current = result.nextPhases;

    // Cancel pending completion toasts for threads that resumed work or vanished
    // — the "another step" case that otherwise reads as a fresh finish.
    for (const key of result.completedExitedKeys) {
      const timer = timers.get(key);
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(key);
      }
    }

    const syncAttention = () => {
      const waiting =
        !document.hasFocus() && (result.waitingCount > 0 || hasUnseenAlertsRef.current);
      void window.desktopBridge?.setAttentionState?.({ waiting });
    };

    if (!seededRef.current) {
      seededRef.current = true;
      syncAttention();
      return;
    }

    deliverItems(result.immediate);

    // Defer completions: fire only once the thread has stayed "completed" for
    // the debounce window. If it resumes work, the exit above clears this timer
    // before it fires, so a thread taking another step stays quiet.
    for (const item of result.completedEntered) {
      if (timers.has(item.key)) continue;
      const timer = setTimeout(() => {
        timers.delete(item.key);
        deliverRef.current([item]);
      }, COMPLETION_DEBOUNCE_MS);
      timers.set(item.key, timer);
    }

    syncAttention();
  }, [deliverItems, projects, threadShells]);

  useEffect(() => {
    if (!notificationsEnabled) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") void Notification.requestPermission();
  }, [notificationsEnabled]);

  useEffect(() => {
    const clearAttention = () => {
      hasUnseenAlertsRef.current = false;
      void window.desktopBridge?.setAttentionState?.({ waiting: false });
    };
    window.addEventListener("focus", clearAttention);
    return () => window.removeEventListener("focus", clearAttention);
  }, []);

  useEffect(() => {
    const timers = completionTimersRef.current;
    const live = liveNotificationsRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      live.clear();
    };
  }, []);
}
