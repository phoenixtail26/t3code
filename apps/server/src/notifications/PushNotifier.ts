import type {
  OrchestrationThreadShell,
  PushNotificationSettings,
  ThreadId,
} from "@t3tools/contracts";
import type { AgentAwarenessPhase, AgentAwarenessState } from "@t3tools/shared/agentAwareness";

/**
 * Phone notifications for thread events, delivered over ntfy (https://ntfy.sh
 * or a private ntfy server) and/or Web Push to the installed PWA, so the
 * owner learns a thread needs them without watching the UI.
 *
 * Why ntfy rather than T3 Connect's relay push: this fork is driven from a
 * tailnet with no cloud account, and ntfy is a single POST with a
 * first-class mobile app. The awareness phase ladder
 * (`@t3tools/shared/agentAwareness`) is shared with the relay path, so both
 * transports agree on what "needs attention" means. Web Push (roadmap #6)
 * removes even the ntfy hop for devices that register a subscription.
 *
 * This module decides WHETHER a notification fires and renders it; it is
 * channel-agnostic. Delivery — to which channels, with what transport —
 * lives in `PushNotifierService`.
 *
 * Notifications fire on phase TRANSITIONS: a thread sitting at
 * `waiting_for_approval` across many domain events notifies once, and the
 * same phase notifies again only after the thread has moved away and back.
 */

/**
 * How long a completion push waits before delivery. The last background task
 * finishing clears `backgroundLiveness` a few seconds before the agent
 * resumes with a fresh turn, so the thread reads "completed" in that window;
 * the recheck re-reads the thread after this delay and delivers only if it is
 * still settled. Mirrors the web client's COMPLETION_DEBOUNCE_MS.
 */
export const COMPLETION_RECHECK_MS = 10_000;

/**
 * The awareness ladder reads a settled turn as "completed", but native
 * background work (subagents, workflows, watch loops) outlives the turn: the
 * agent yields, the work keeps running, and a fresh turn starts when it lands.
 * `backgroundLiveness` is the server's signal for exactly that window — the
 * same one that keeps the sidebar pill at "Working" instead of "Done"
 * (ThreadBackgroundLivenessService) — so the phase is held at "running" until
 * it clears and a finish push fires only when the pill would go green.
 */
export function awarenessWithBackgroundLiveness(
  state: AgentAwarenessState | null,
  backgroundLiveness: OrchestrationThreadShell["backgroundLiveness"],
): AgentAwarenessState | null {
  if (state === null || state.phase !== "completed" || backgroundLiveness == null) {
    return state;
  }
  return { ...state, phase: "running" };
}

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
