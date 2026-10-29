import type { PushNotificationSettings, ThreadId } from "@t3tools/contracts";
import type { AgentAwarenessPhase, AgentAwarenessState } from "@t3tools/shared/agentAwareness";

/**
 * Phone notifications for thread events over ntfy and/or Web Push. Decides
 * WHETHER a notification fires and renders it; delivery lives in
 * `PushNotifierService`. Fires on phase TRANSITIONS: a thread sitting in one
 * phase notifies once, and again only after moving away and back.
 */

/**
 * How long a completion push waits before delivery. The last background task
 * finishing lands seconds before the agent resumes, so the thread briefly reads
 * "completed"; the recheck delivers only if it is still settled. Mirrors the
 * web client's COMPLETION_DEBOUNCE_MS.
 */
export const COMPLETION_RECHECK_MS = 10_000;

const PHASE_PRIORITY: Partial<Record<AgentAwarenessPhase, string>> = {
  waiting_for_approval: "high",
  waiting_for_input: "high",
  failed: "high",
  completed: "default",
};

const PHASE_TAGS: Partial<Record<AgentAwarenessPhase, string>> = {
  waiting_for_approval: "warning",
  waiting_for_input: "speech_balloon",
  failed: "rotating_light",
  completed: "white_check_mark",
};

export interface PushNotification {
  readonly title: string;
  readonly body: string;
  /** ntfy priority; Web Push maps "high" to urgency "high". */
  readonly priority: string;
  /** ntfy emoji tags. */
  readonly tags: string;
  /** Coalescing key: repeated pushes for one thread replace, not stack. */
  readonly threadTag: string;
  readonly clickUrl?: string;
}

function phaseEnabled(phase: AgentAwarenessPhase, settings: PushNotificationSettings): boolean {
  switch (phase) {
    case "waiting_for_approval":
      return settings.notifyOnApproval;
    case "waiting_for_input":
      return settings.notifyOnInput;
    case "failed":
      return settings.notifyOnFailure;
    case "completed":
      return settings.notifyOnCompletion;
    default:
      // starting/running/stale are progress noise, never notified.
      return false;
  }
}

/**
 * Web route for a thread. `buildAgentAwarenessDeepLink` targets the mobile
 * app's router (`/threads/...`); the browser route this server serves is
 * `/<environmentId>/<threadId>`.
 */
export function buildThreadWebUrl(publicBaseUrl: string, state: AgentAwarenessState): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(state.environmentId)}/${encodeURIComponent(state.threadId)}`;
}

/**
 * Decide whether a thread's new awareness state warrants a notification and
 * render it. Returns null when the phase is unchanged since the last
 * observation or the phase is uninteresting/disabled. Channel enablement
 * (topic URL, Web Push subscriptions) is the caller's concern.
 */
export function resolvePushNotification(input: {
  readonly settings: PushNotificationSettings;
  readonly state: AgentAwarenessState | null;
  readonly lastObservedPhase: AgentAwarenessPhase | undefined;
}): PushNotification | null {
  const { settings, state, lastObservedPhase } = input;
  if (state === null) return null;
  if (state.phase === lastObservedPhase) return null;
  if (!phaseEnabled(state.phase, settings)) return null;

  const detail = state.detail ? `\n${state.detail}` : "";
  return {
    title: `${state.headline}: ${state.threadTitle}`,
    body: `${state.projectTitle} · ${state.modelTitle}${detail}`,
    priority: PHASE_PRIORITY[state.phase] ?? "default",
    tags: PHASE_TAGS[state.phase] ?? "robot",
    threadTag: state.threadId,
    ...(settings.publicBaseUrl.length > 0
      ? { clickUrl: buildThreadWebUrl(settings.publicBaseUrl, state) }
      : {}),
  };
}

/**
 * Last observed phase per thread. Transitions are computed against this, so
 * every phase change is evaluated exactly once regardless of how many domain
 * events carried it.
 */
export class ObservedPhaseTracker {
  private readonly phaseByThread = new Map<ThreadId, AgentAwarenessPhase>();

  get(threadId: ThreadId): AgentAwarenessPhase | undefined {
    return this.phaseByThread.get(threadId);
  }

  /** Record the phase just observed. A null state forgets the thread. */
  observe(threadId: ThreadId, phase: AgentAwarenessPhase | null): void {
    if (phase === null) {
      this.phaseByThread.delete(threadId);
      return;
    }
    this.phaseByThread.set(threadId, phase);
  }
}
