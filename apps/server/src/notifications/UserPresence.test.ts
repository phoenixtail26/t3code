import { describe, expect, it } from "@effect/vitest";

import {
  isUserPresent,
  readLastPresenceMs,
  recordUserPresence,
  resetUserPresence,
} from "./UserPresence.ts";

describe("isUserPresent", () => {
  const nowMs = 1_000_000;

  it("is true inside the suppression window", () => {
    expect(isUserPresent({ nowMs, windowSeconds: 300, lastPresentAtMs: nowMs - 60_000 })).toBe(
      true,
    );
  });

  it("is false once the window has elapsed", () => {
    expect(isUserPresent({ nowMs, windowSeconds: 300, lastPresentAtMs: nowMs - 301_000 })).toBe(
      false,
    );
  });

  it("treats the window boundary as still present", () => {
    expect(isUserPresent({ nowMs, windowSeconds: 300, lastPresentAtMs: nowMs - 300_000 })).toBe(
      true,
    );
  });

  it("never suppresses when presence was never reported", () => {
    expect(isUserPresent({ nowMs, windowSeconds: 300, lastPresentAtMs: null })).toBe(false);
  });

  it("disables suppression for a zero or negative window", () => {
    expect(isUserPresent({ nowMs, windowSeconds: 0, lastPresentAtMs: nowMs })).toBe(false);
    expect(isUserPresent({ nowMs, windowSeconds: -5, lastPresentAtMs: nowMs })).toBe(false);
  });
});

describe("presence recording", () => {
  it("records and clears the last presence timestamp", () => {
    resetUserPresence();
    expect(readLastPresenceMs()).toBeNull();

    recordUserPresence(1234);
    expect(readLastPresenceMs()).toBe(1234);

    resetUserPresence();
    expect(readLastPresenceMs()).toBeNull();
  });
});
