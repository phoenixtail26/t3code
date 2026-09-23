import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../hooks/useSettings", () => ({ getClientSettings: () => ({}) }));
vi.mock("../lib/notificationSound", () => ({ playNotificationSound: vi.fn() }));
vi.mock("../threadNotifications", () => ({
  playNotificationSound: vi.fn(),
  unlockNotificationAudio: vi.fn(),
}));

import {
  COMPLETION_DEBOUNCE_MS,
  useCompletionDebounce,
  type CompletionDebounce,
} from "./threadNotifications";

const THREAD = "thread-1" as never;
let latest: CompletionDebounce | undefined;
let renders = 0;
let renderer: ReactTestRenderer | undefined;

function Harness() {
  latest = useCompletionDebounce();
  renders += 1;
  return null;
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  renders = 0;
  await act(async () => {
    renderer = create(<Harness />);
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("holds a completion for the window, re-renders on expiry, then reports ready exactly once", async () => {
  const before = latest!;
  expect(before.ready(THREAD)).toBe(false);
  // Repeat passes while armed neither deliver nor reset the timer.
  await advance(COMPLETION_DEBOUNCE_MS - 1);
  expect(before.ready(THREAD)).toBe(false);
  expect(renders).toBe(1);

  await advance(1);
  expect(renders).toBe(2);
  expect(latest).not.toBe(before);
  expect(latest!.ready(THREAD)).toBe(true);
  // Consumed: the next pass starts a fresh hold instead of re-delivering.
  expect(latest!.ready(THREAD)).toBe(false);
});

it("never becomes ready for a thread that resumes work inside the window", async () => {
  expect(latest!.ready(THREAD)).toBe(false);
  await advance(COMPLETION_DEBOUNCE_MS / 2);
  latest!.cancel(THREAD);
  await advance(COMPLETION_DEBOUNCE_MS);
  expect(renders).toBe(1);
  expect(latest!.ready(THREAD)).toBe(false);
});

it("drops a settled completion when the thread resumes before delivery", async () => {
  expect(latest!.ready(THREAD)).toBe(false);
  await advance(COMPLETION_DEBOUNCE_MS);
  latest!.cancel(THREAD);
  expect(latest!.ready(THREAD)).toBe(false);
});

it("keeps upstream's tag while it fits and falls back to the thread id past the Electron ceiling", async () => {
  const { notificationTag, MAX_NOTIFICATION_TAG_LENGTH } = await import("./threadNotifications");
  expect(notificationTag("env-1", "thread-1")).toBe("env-1:thread-1");
  const environmentId = "698d507e-4e69-4c61-b2f8-f2ba333bd11c";
  const threadId = "7a3ea668-f23f-4047-8956-6b2e6680603f";
  const tag = notificationTag(environmentId, threadId);
  expect(tag).toBe(threadId);
  expect(tag.length).toBeLessThanOrEqual(MAX_NOTIFICATION_TAG_LENGTH);
});
