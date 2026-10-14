// Fork feature: dictation. Holds the `composer.dictate` chord as a system-wide
// accelerator so a recording started in T3 Code can be stopped from another
// app. The renderer decides which chord (keybindings are server settings) and
// whether the hook is on (a client setting) and pushes both through
// `setDictationGlobalStop`; a press is forwarded to every window over
// DICTATION_GLOBAL_STOP_EVENT_CHANNEL, where the renderer stops a recording
// only when the window is not focused. Nothing here starts a dictation.
import type { DesktopDictationGlobalStopResult, KeybindingShortcut } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";

import { toElectronAccelerator } from "../snapShot/snapShot.ts";
import { DICTATION_GLOBAL_STOP_EVENT_CHANNEL } from "./channels.ts";

export interface GlobalShortcutLike {
  readonly register: (accelerator: string, callback: () => void) => boolean;
  readonly unregister: (accelerator: string) => void;
}

const RELEASED: DesktopDictationGlobalStopResult = { registered: false, message: null };

function hasModifier(shortcut: KeybindingShortcut): boolean {
  return (
    shortcut.modKey || shortcut.ctrlKey || shortcut.altKey || shortcut.shiftKey || shortcut.metaKey
  );
}

/** Pure registration state, so tests drive it with a fake `globalShortcut`. */
export class DictationGlobalStopRegistrar {
  readonly #shortcuts: GlobalShortcutLike;
  readonly #onPress: () => void;
  #accelerator: string | null = null;
  #result: DesktopDictationGlobalStopResult = RELEASED;

  constructor(shortcuts: GlobalShortcutLike, onPress: () => void) {
    this.#shortcuts = shortcuts;
    this.#onPress = onPress;
  }

  get result(): DesktopDictationGlobalStopResult {
    return this.#result;
  }

  /** Null releases the key; the same chord twice is a no-op. */
  apply(shortcut: KeybindingShortcut | null): DesktopDictationGlobalStopResult {
    if (shortcut === null) {
      this.release();
      return this.#result;
    }
    if (!hasModifier(shortcut)) {
      this.release();
      this.#result = {
        registered: false,
        message: "A dictation shortcut without a modifier cannot be held system-wide.",
      };
      return this.#result;
    }
    const accelerator = toElectronAccelerator(shortcut);
    if (accelerator === this.#accelerator) return this.#result;
    this.release();
    let registered = false;
    try {
      registered = this.#shortcuts.register(accelerator, this.#onPress);
    } catch {
      registered = false;
    }
    this.#accelerator = registered ? accelerator : null;
    this.#result = registered
      ? { registered: true, message: null }
      : {
          registered: false,
          message: `${accelerator} is held by another app, so it only stops dictation while T3 Code is focused.`,
        };
    return this.#result;
  }

  release(): void {
    if (this.#accelerator !== null) {
      this.#shortcuts.unregister(this.#accelerator);
      this.#accelerator = null;
    }
    this.#result = RELEASED;
  }
}

export class DesktopDictationGlobalStop extends Context.Service<
  DesktopDictationGlobalStop,
  {
    readonly apply: (
      shortcut: KeybindingShortcut | null,
    ) => Effect.Effect<DesktopDictationGlobalStopResult>;
  }
>()("@t3tools/desktop/dictation/DesktopDictationGlobalStop") {}

function forwardPress(): void {
  for (const window of Electron.BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(DICTATION_GLOBAL_STOP_EVENT_CHANNEL);
  }
}

export const make = Effect.gen(function* () {
  const registrar = new DictationGlobalStopRegistrar(Electron.globalShortcut, forwardPress);
  yield* Effect.addFinalizer(() => Effect.sync(() => registrar.release()));
  return DesktopDictationGlobalStop.of({
    apply: (shortcut) =>
      Effect.sync(() => registrar.apply(shortcut)).pipe(
        Effect.withSpan("desktop.dictation.globalStop.apply"),
      ),
  });
});

export const layer = Layer.effect(DesktopDictationGlobalStop, make);
