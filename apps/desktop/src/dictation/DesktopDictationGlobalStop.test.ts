import type { KeybindingShortcut } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { registerMock, unregisterMock, sendMock } = vi.hoisted(() => ({
  registerMock: vi.fn<(accelerator: string, callback: () => void) => boolean>(() => true),
  unregisterMock: vi.fn<(accelerator: string) => void>(),
  sendMock: vi.fn<(channel: string) => void>(),
}));

vi.mock("electron", () => ({
  globalShortcut: { register: registerMock, unregister: unregisterMock },
  BrowserWindow: {
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

beforeEach(() => {
  registerMock.mockReset().mockReturnValue(true);
  unregisterMock.mockReset();
  sendMock.mockReset();
});

describe("DictationGlobalStopRegistrar", () => {
  it("registers the chord once and forwards presses", () => {
    const onPress = vi.fn();
    const registrar = new DictationGlobalStopRegistrar(
      { register: registerMock, unregister: unregisterMock },
      onPress,
    );
    expect(registrar.apply(chord())).toEqual({ registered: true, message: null });
    expect(registrar.apply(chord())).toEqual({ registered: true, message: null });
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock.mock.calls[0]?.[0]).toBe("Control+Alt+Shift+U");
    registerMock.mock.calls[0]?.[1]();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("re-registers when the chord changes and releases on null", () => {
    const registrar = new DictationGlobalStopRegistrar(
      { register: registerMock, unregister: unregisterMock },
      () => undefined,
    );
    registrar.apply(chord());
    registrar.apply(chord({ key: "d", modKey: true, ctrlKey: false, altKey: false }));
    expect(unregisterMock).toHaveBeenCalledWith("Control+Alt+Shift+U");
    expect(registerMock.mock.calls[1]?.[0]).toBe("CommandOrControl+Shift+D");
    expect(registrar.apply(null)).toEqual({ registered: false, message: null });
    expect(unregisterMock).toHaveBeenLastCalledWith("CommandOrControl+Shift+D");
    registrar.apply(null);
    expect(unregisterMock).toHaveBeenCalledTimes(2);
  });

  it("reports a key held by another app and one without a modifier", () => {
    registerMock.mockReturnValue(false);
    const registrar = new DictationGlobalStopRegistrar(
      { register: registerMock, unregister: unregisterMock },
      () => undefined,
    );
    const taken = registrar.apply(chord());
    expect(taken.registered).toBe(false);
    expect(taken.message).toContain("Control+Alt+Shift+U");
    registerMock.mockReturnValue(true);
    // A failed registration is not cached: the next apply tries again.
    expect(registrar.apply(chord()).registered).toBe(true);
    const bare = registrar.apply(chord({ ctrlKey: false, altKey: false, shiftKey: false }));
    expect(bare.registered).toBe(false);
    expect(bare.message).toContain("modifier");
    expect(unregisterMock).toHaveBeenCalledWith("Control+Alt+Shift+U");
  });
});

describe("DesktopDictationGlobalStop layer", () => {
  it("sends presses to live windows and releases the key when the scope closes", async () => {
    await Effect.gen(function* () {
      const globalStop = yield* DesktopDictationGlobalStop;
      const result = yield* globalStop.apply(chord());
      expect(result.registered).toBe(true);
      registerMock.mock.calls[0]?.[1]();
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock).toHaveBeenCalledWith(DICTATION_GLOBAL_STOP_EVENT_CHANNEL);
      expect(unregisterMock).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
    expect(unregisterMock).toHaveBeenCalledWith("Control+Alt+Shift+U");
  });
});
