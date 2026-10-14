import { it as effectIt } from "@effect/vitest";
import type { KeybindingShortcut } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { registerMock, unregisterMock, sendMock, focusedWindow, appListeners } = vi.hoisted(() => ({
  registerMock: vi.fn<(accelerator: string, callback: () => void) => boolean>(() => true),
  unregisterMock: vi.fn<(accelerator: string) => void>(),
  sendMock: vi.fn<(channel: string) => void>(),
  focusedWindow: { value: null as object | null },
  appListeners: new Map<string, Set<() => void>>(),
}));

vi.mock("electron", () => ({
  app: {
    on: (event: string, listener: () => void) => {
      const set = appListeners.get(event) ?? new Set();
      set.add(listener);
      appListeners.set(event, set);
    },
    removeListener: (event: string, listener: () => void) => {
      appListeners.get(event)?.delete(listener);
    },
  },
  globalShortcut: { register: registerMock, unregister: unregisterMock },
  BrowserWindow: {
    getFocusedWindow: () => focusedWindow.value,
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: sendMock } },
      { isDestroyed: () => true, webContents: { send: sendMock } },
    ],
  },
}));

import {
  DesktopDictationGlobalStop,
  DictationGlobalStopRegistrar,
  layer,
} from "./DesktopDictationGlobalStop.ts";
import { DICTATION_GLOBAL_STOP_EVENT_CHANNEL } from "./channels.ts";

const chord = (overrides: Partial<KeybindingShortcut> = {}): KeybindingShortcut => ({
  key: "u",
  ctrlKey: true,
  altKey: true,
  shiftKey: true,
  metaKey: false,
  modKey: false,
  ...overrides,
});
const ACCEL = "Control+Alt+Shift+U";

function emit(event: string) {
  for (const listener of appListeners.get(event) ?? []) listener();
}

function registrar(onPress: () => void = () => undefined) {
  return new DictationGlobalStopRegistrar(
    { register: registerMock, unregister: unregisterMock },
    onPress,
  );
}

beforeEach(() => {
  registerMock.mockReset().mockReturnValue(true);
  unregisterMock.mockReset();
  sendMock.mockReset();
  focusedWindow.value = null;
  appListeners.clear();
});

describe("DictationGlobalStopRegistrar", () => {
  it("holds the key immediately when no window is focused and forwards presses", () => {
    const onPress = vi.fn();
    const r = registrar(onPress);
    expect(r.apply(chord(), false)).toEqual({ registered: true, message: null });
    expect(r.held).toBe(ACCEL);
    expect(r.apply(chord(), false)).toEqual({ registered: true, message: null });
    expect(registerMock).toHaveBeenCalledTimes(1);
    registerMock.mock.calls[0]?.[1]();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("only probes the key while a window is focused", () => {
    const r = registrar();
    expect(r.apply(chord(), true)).toEqual({ registered: true, message: null });
    expect(registerMock).toHaveBeenCalledWith(ACCEL, expect.any(Function));
    expect(unregisterMock).toHaveBeenCalledWith(ACCEL);
    expect(r.held).toBeNull();
  });

  it("releases on focus and takes the key back on blur", () => {
    const r = registrar();
    r.apply(chord(), false);
    r.windowFocused();
    expect(unregisterMock).toHaveBeenCalledWith(ACCEL);
    expect(r.held).toBeNull();
    r.windowBlurred();
    expect(r.held).toBe(ACCEL);
    expect(registerMock).toHaveBeenCalledTimes(2);
    r.windowBlurred();
    expect(registerMock).toHaveBeenCalledTimes(2);
  });

  it("a chord change while focused holds nothing until blur, then holds the new chord", () => {
    const r = registrar();
    r.apply(chord(), false);
    r.windowFocused();
    registerMock.mockClear();
    unregisterMock.mockClear();
    r.apply(chord({ key: "d", modKey: true, ctrlKey: false, altKey: false }), true);
    expect(r.held).toBeNull();
    expect(unregisterMock).toHaveBeenCalledWith("CommandOrControl+Shift+D");
    r.windowBlurred();
    expect(r.held).toBe("CommandOrControl+Shift+D");
  });

  it("null releases the key and forgets the chord", () => {
    const r = registrar();
    r.apply(chord(), false);
    expect(r.apply(null, false)).toEqual({ registered: false, message: null });
    expect(unregisterMock).toHaveBeenCalledWith(ACCEL);
    r.windowBlurred();
    expect(r.held).toBeNull();
    expect(registerMock).toHaveBeenCalledTimes(1);
  });

  it("reports a key held by another app and one without a modifier", () => {
    registerMock.mockReturnValue(false);
    const r = registrar();
    const taken = r.apply(chord(), true);
    expect(taken.registered).toBe(false);
    expect(taken.message).toContain(ACCEL);
    expect(r.held).toBeNull();
    registerMock.mockReturnValue(true);
    // A failed probe is not cached: the next apply tries again.
    expect(r.apply(chord(), true).registered).toBe(true);
    const bare = r.apply(chord({ ctrlKey: false, altKey: false, shiftKey: false }), false);
    expect(bare.registered).toBe(false);
    expect(bare.message).toContain("modifier");
    expect(r.held).toBeNull();
  });
});

describe("DesktopDictationGlobalStop layer", () => {
  effectIt.effect("follows app focus, sends presses to live windows and releases on scope close", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const globalStop = yield* DesktopDictationGlobalStop;
      focusedWindow.value = {};
      const result = yield* globalStop.apply(chord());
      expect(result.registered).toBe(true);
      // Probed and released while focused.
      expect(unregisterMock).toHaveBeenCalledWith(ACCEL);
      registerMock.mockClear();

      focusedWindow.value = null;
      emit("browser-window-blur");
      expect(registerMock).not.toHaveBeenCalled();
      yield* TestClock.adjust("1 millis");
      expect(registerMock).toHaveBeenCalledWith(ACCEL, expect.any(Function));
      registerMock.mock.calls[0]?.[1]();
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock).toHaveBeenCalledWith(DICTATION_GLOBAL_STOP_EVENT_CHANNEL);

      // Blur followed by focus of another window of ours: nothing registers.
      unregisterMock.mockClear();
      focusedWindow.value = {};
      emit("browser-window-focus");
      expect(unregisterMock).toHaveBeenCalledWith(ACCEL);
      registerMock.mockClear();
      emit("browser-window-blur");
      yield* TestClock.adjust("1 millis");
      expect(registerMock).not.toHaveBeenCalled();

      focusedWindow.value = null;
      emit("browser-window-blur");
      yield* TestClock.adjust("1 millis");
      expect(registerMock).toHaveBeenCalledTimes(1);
      unregisterMock.mockClear();
      }).pipe(Effect.provide(layer), Effect.scoped);
      expect(unregisterMock).toHaveBeenCalledWith(ACCEL);
      expect(appListeners.get("browser-window-focus")?.size ?? 0).toBe(0);
      expect(appListeners.get("browser-window-blur")?.size ?? 0).toBe(0);
    }),
  );
});
