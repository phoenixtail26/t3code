import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";

/**
 * Pure transition classification for thread attention notifications.
 *
 * The renderer resolves each thread to an {@link AgentAwarenessPhase} and this
 * module decides, from the phase change since last pass, what to do:
 *
 * - `immediate`  — blocking phases (approval/input needed, failed) that are
 *   stable states worth a toast the moment they appear.
 * - `completedEntered` — threads that just reached "completed". These are NOT
 *   fired immediately: an agent doing another step dips through "completed"
 *   between turns, so the hook debounces them and only notifies once the phase
 *   holds. This is what stops the burst of false "agent finished" toasts.
 * - `completedExitedKeys` — threads that left "completed" (resumed work) or
 *   vanished; the hook cancels their pending completion toast.
 *
 * Keeping this pure makes the transition rules unit-testable; the timer
 * plumbing (arm/cancel/fire) lives in the hook.
 */

export interface AttentionNotification {
  readonly key: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly body: string;
}

export interface ThreadAwarenessSnapshot extends AttentionNotification {
  readonly phase: AgentAwarenessPhase;
}

/**
 * How long a thread must stay "completed" before its finish toast fires. A
 * thread taking another step leaves "completed" (cancelling the timer) well
 * within this window, so step boundaries stay quiet; a real finish notifies
 * after the delay. Tunable — longer suppresses slower step gaps at the cost of
 * a later "done" toast.
 */
export const COMPLETION_DEBOUNCE_MS = 10_000;

/** Blocking phases worth an immediate toast — stable, not step-boundary flicker. */
export const IMMEDIATE_ALERT_PHASES: ReadonlySet<AgentAwarenessPhase> = new Set([
  "waiting_for_approval",
  "waiting_for_input",
  "failed",
]);

const COMPLETION_PHASE: AgentAwarenessPhase = "completed";

/** Phases that keep the taskbar lit even without a fresh transition. */
export const WAITING_PHASES: ReadonlySet<AgentAwarenessPhase> = new Set([
  "waiting_for_approval",
  "waiting_for_input",
]);

export interface ThreadTransitionClassification {
  readonly immediate: readonly AttentionNotification[];
  readonly completedEntered: readonly AttentionNotification[];
  readonly completedExitedKeys: readonly string[];
  readonly waitingCount: number;
  readonly nextPhases: Map<string, AgentAwarenessPhase>;
}

export function classifyThreadTransitions(params: {
  readonly previousPhases: ReadonlyMap<string, AgentAwarenessPhase>;
  readonly snapshots: readonly ThreadAwarenessSnapshot[];
  /**
   * False on the very first pass so a client starting up with threads already
   * completed/waiting adopts that state silently instead of firing a burst.
   */
  readonly seeded: boolean;
}): ThreadTransitionClassification {
  const { previousPhases, snapshots, seeded } = params;
  const nextPhases = new Map<string, AgentAwarenessPhase>();
  const immediate: AttentionNotification[] = [];
  const completedEntered: AttentionNotification[] = [];
  const completedExitedKeys: string[] = [];
  const seen = new Set<string>();
  let waitingCount = 0;

  for (const snapshot of snapshots) {
    const { key, phase } = snapshot;
    seen.add(key);
    nextPhases.set(key, phase);
    if (WAITING_PHASES.has(phase)) waitingCount += 1;

    const previous = previousPhases.get(key);
    if (previous === phase) continue;

    // Leaving "completed" (resumed work) cancels any pending finish toast.
    if (previous === COMPLETION_PHASE && phase !== COMPLETION_PHASE) {
      completedExitedKeys.push(key);
    }
    if (!seeded) continue;
    if (IMMEDIATE_ALERT_PHASES.has(phase)) {
      immediate.push(toNotification(snapshot));
    } else if (phase === COMPLETION_PHASE) {
      completedEntered.push(toNotification(snapshot));
    }
  }

  // Threads that vanished while parked at "completed" also cancel their toast.
  for (const [key, phase] of previousPhases) {
    if (phase === COMPLETION_PHASE && !seen.has(key)) completedExitedKeys.push(key);
  }

  return { immediate, completedEntered, completedExitedKeys, waitingCount, nextPhases };
}

function toNotification(snapshot: ThreadAwarenessSnapshot): AttentionNotification {
  return {
    key: snapshot.key,
    environmentId: snapshot.environmentId,
    threadId: snapshot.threadId,
    title: snapshot.title,
    body: snapshot.body,
  };
}
