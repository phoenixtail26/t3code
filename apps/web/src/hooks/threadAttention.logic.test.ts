import { describe, expect, it } from "vite-plus/test";
import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";

import { classifyThreadTransitions, type ThreadAwarenessSnapshot } from "./threadAttention.logic";

function snapshot(key: string, phase: AgentAwarenessPhase): ThreadAwarenessSnapshot {
  return {
    key,
    environmentId: "env",
    threadId: key,
    phase,
    title: `title-${key}`,
    body: `body-${key}`,
  };
}

const seededEmpty = new Map<string, AgentAwarenessPhase>();

describe("classifyThreadTransitions", () => {
  it("emits nothing on the seed pass but records phases", () => {
    const result = classifyThreadTransitions({
      previousPhases: seededEmpty,
      snapshots: [snapshot("a", "completed"), snapshot("b", "waiting_for_input")],
      seeded: false,
    });
    expect(result.immediate).toEqual([]);
    expect(result.completedEntered).toEqual([]);
    expect(result.completedExitedKeys).toEqual([]);
    expect(result.nextPhases.get("a")).toBe("completed");
    expect(result.nextPhases.get("b")).toBe("waiting_for_input");
  });

  it("fires blocking phases immediately", () => {
    const result = classifyThreadTransitions({
      previousPhases: new Map([["a", "running"]]),
      snapshots: [snapshot("a", "waiting_for_approval")],
      seeded: true,
    });
    expect(result.immediate.map((n) => n.key)).toEqual(["a"]);
    expect(result.completedEntered).toEqual([]);
  });

  it("treats failed as an immediate alert", () => {
    const result = classifyThreadTransitions({
      previousPhases: new Map([["a", "running"]]),
      snapshots: [snapshot("a", "failed")],
      seeded: true,
    });
    expect(result.immediate.map((n) => n.key)).toEqual(["a"]);
  });

  it("defers completion (not immediate)", () => {
    const result = classifyThreadTransitions({
      previousPhases: new Map([["a", "running"]]),
      snapshots: [snapshot("a", "completed")],
      seeded: true,
    });
    expect(result.immediate).toEqual([]);
    expect(result.completedEntered.map((n) => n.key)).toEqual(["a"]);
    expect(result.completedExitedKeys).toEqual([]);
  });

  it("does not re-arm a thread that stays completed", () => {
    const result = classifyThreadTransitions({
      previousPhases: new Map([["a", "completed"]]),
      snapshots: [snapshot("a", "completed")],
      seeded: true,
    });
    expect(result.completedEntered).toEqual([]);
    expect(result.completedExitedKeys).toEqual([]);
  });

  it("does not notify a thread first observed already completed (booting with old threads)", () => {
    const result = classifyThreadTransitions({
      previousPhases: seededEmpty,
      snapshots: [snapshot("a", "completed"), snapshot("b", "completed")],
      seeded: true,
    });
    expect(result.completedEntered).toEqual([]);
    expect(result.immediate).toEqual([]);
    expect(result.completedExitedKeys).toEqual([]);
    expect(result.nextPhases.get("a")).toBe("completed");
  });

  it("does not notify a thread first observed already blocked", () => {
    const result = classifyThreadTransitions({
      previousPhases: seededEmpty,
      snapshots: [snapshot("a", "waiting_for_approval")],
      seeded: true,
    });
    expect(result.immediate).toEqual([]);
  });

  it("still notifies a known thread that later completes", () => {
    // First sight running (adopted silently), then a witnessed completion.
    const first = classifyThreadTransitions({
      previousPhases: seededEmpty,
      snapshots: [snapshot("a", "running")],
      seeded: true,
    });
    expect(first.completedEntered).toEqual([]);
    const second = classifyThreadTransitions({
      previousPhases: first.nextPhases,
      snapshots: [snapshot("a", "completed")],
      seeded: true,
    });
    expect(second.completedEntered.map((n) => n.key)).toEqual(["a"]);
  });

  it("cancels a pending completion when the thread resumes work (a step boundary)", () => {
    const result = classifyThreadTransitions({
      previousPhases: new Map([["a", "completed"]]),
      snapshots: [snapshot("a", "running")],
      seeded: true,
    });
    expect(result.completedExitedKeys).toEqual(["a"]);
    expect(result.immediate).toEqual([]);
    expect(result.completedEntered).toEqual([]);
  });

  it("cancels a pending completion when the thread vanishes", () => {
    const result = classifyThreadTransitions({
      previousPhases: new Map([["a", "completed"]]),
      snapshots: [],
      seeded: true,
    });
    expect(result.completedExitedKeys).toEqual(["a"]);
  });

  it("counts only approval/input phases toward the waiting badge", () => {
    const result = classifyThreadTransitions({
      previousPhases: seededEmpty,
      snapshots: [
        snapshot("a", "waiting_for_approval"),
        snapshot("b", "waiting_for_input"),
        snapshot("c", "completed"),
        snapshot("d", "running"),
      ],
      seeded: true,
    });
    expect(result.waitingCount).toBe(2);
  });

  it("re-arms after a completed → running → completed round trip", () => {
    // running → completed: armed
    const first = classifyThreadTransitions({
      previousPhases: new Map([["a", "running"]]),
      snapshots: [snapshot("a", "completed")],
      seeded: true,
    });
    expect(first.completedEntered.map((n) => n.key)).toEqual(["a"]);
    // completed → running: cancelled
    const second = classifyThreadTransitions({
      previousPhases: first.nextPhases,
      snapshots: [snapshot("a", "running")],
      seeded: true,
    });
    expect(second.completedExitedKeys).toEqual(["a"]);
    // running → completed again: re-armed
    const third = classifyThreadTransitions({
      previousPhases: second.nextPhases,
      snapshots: [snapshot("a", "completed")],
      seeded: true,
    });
    expect(third.completedEntered.map((n) => n.key)).toEqual(["a"]);
  });
});
