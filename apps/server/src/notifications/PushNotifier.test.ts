import type { PushNotificationSettings, ThreadId } from "@t3tools/contracts";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { describe, expect, it } from "@effect/vitest";

import {
  buildThreadWebUrl,
  ObservedPhaseTracker,
  resolvePushNotification,
} from "./PushNotifier.ts";

const threadId = "thread-1" as ThreadId;

const enabledSettings: PushNotificationSettings = {
  topicUrl: "https://ntfy.sh/secret-topic",
  publicBaseUrl: "https://machine.tailnet.ts.net",
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnFailure: true,
  notifyOnCompletion: true,
  suppressWhenPresentSeconds: 300,
};

function makeState(overrides: Partial<AgentAwarenessState> = {}): AgentAwarenessState {
  return {
    environmentId: "env-1",
    threadId: threadId,
    projectTitle: "forsaken",
    threadTitle: "Fix the worm spawn",
    phase: "waiting_for_approval",
    headline: "Approval needed",
    modelTitle: "claude-fable-5",
    updatedAt: "2026-07-18T09:00:00Z",
    deepLink: "/threads/env-1/thread-1",
    ...overrides,
  } as AgentAwarenessState;
}

describe("resolvePushNotification", () => {
  it("renders an approval notification with a click-through web URL", () => {
    const notification = resolvePushNotification({
      settings: enabledSettings,
      state: makeState(),
      lastObservedPhase: "running",
    });

    expect(notification).toEqual({
      title: "Approval needed: Fix the worm spawn",
      body: "forsaken · claude-fable-5",
      priority: "high",
      tags: "warning",
      threadTag: "thread-1",
      clickUrl: "https://machine.tailnet.ts.net/env-1/thread-1",
    });
  });

  it("still resolves without a topic URL — channel enablement is the caller's concern", () => {
    expect(
      resolvePushNotification({
        settings: { ...enabledSettings, topicUrl: "" },
        state: makeState(),
        lastObservedPhase: "running",
      }),
    ).not.toBeNull();
  });

  it("does not re-notify while the phase is unchanged", () => {
    expect(
      resolvePushNotification({
        settings: enabledSettings,
        state: makeState(),
        lastObservedPhase: "waiting_for_approval",
      }),
    ).toBeNull();
  });

  it("ignores progress phases", () => {
    for (const phase of ["starting", "running", "stale"] as const) {
      expect(
        resolvePushNotification({
          settings: enabledSettings,
          state: makeState({ phase, headline: "x" }),
          lastObservedPhase: undefined,
        }),
      ).toBeNull();
    }
  });

  it("respects per-phase toggles", () => {
    expect(
      resolvePushNotification({
        settings: { ...enabledSettings, notifyOnCompletion: false },
        state: makeState({ phase: "completed", headline: "Agent finished" }),
        lastObservedPhase: "running",
      }),
    ).toBeNull();
  });

  it("includes the failure detail and omits the link when no base URL is set", () => {
    const notification = resolvePushNotification({
      settings: { ...enabledSettings, publicBaseUrl: "" },
      state: makeState({ phase: "failed", headline: "Agent failed", detail: "boom" }),
      lastObservedPhase: "running",
    });
    expect(notification?.body).toBe("forsaken · claude-fable-5\nboom");
    expect(notification?.clickUrl).toBeUndefined();
    expect(notification?.tags).toBe("rotating_light");
  });

  it("notifies on a null-state thread only after it returns to a notifiable phase", () => {
    expect(
      resolvePushNotification({
        settings: enabledSettings,
        state: null,
        lastObservedPhase: "running",
      }),
    ).toBeNull();
  });
});

describe("buildThreadWebUrl", () => {
  it("trims trailing slashes and encodes ids", () => {
    expect(buildThreadWebUrl("https://host/", makeState({ threadId: "a b" as ThreadId }))).toBe(
      "https://host/env-1/a%20b",
    );
  });
});

describe("ObservedPhaseTracker", () => {
  it("remembers the last observed phase and forgets on a null state", () => {
    const tracker = new ObservedPhaseTracker();
    expect(tracker.get(threadId)).toBeUndefined();

    tracker.observe(threadId, "waiting_for_approval");
    expect(tracker.get(threadId)).toBe("waiting_for_approval");

    tracker.observe(threadId, null);
    expect(tracker.get(threadId)).toBeUndefined();
  });

  it("supports re-notifying after the thread leaves and re-enters a phase", () => {
    const tracker = new ObservedPhaseTracker();
    const notify = (phase: AgentAwarenessState["phase"]) => {
      const notification = resolvePushNotification({
        settings: enabledSettings,
        state: makeState({ phase, headline: "Approval needed" }),
        lastObservedPhase: tracker.get(threadId),
      });
      tracker.observe(threadId, phase);
      return notification !== null;
    };

    expect(notify("waiting_for_approval")).toBe(true);
    expect(notify("waiting_for_approval")).toBe(false);
    expect(notify("running")).toBe(false);
    expect(notify("waiting_for_approval")).toBe(true);
  });
});
