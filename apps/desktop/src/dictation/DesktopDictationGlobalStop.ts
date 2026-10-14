// Fork feature: dictation. Holds the `composer.dictate` chord as a system-wide
// accelerator so a recording started in T3 Code can be stopped from another
// app. The renderer decides which chord (keybindings are server settings) and
// whether the hook is on (a client setting) and pushes both through
// `setDictationGlobalStop`; a press is forwarded to every window over
// DICTATION_GLOBAL_STOP_EVENT_CHANNEL. Nothing here starts a dictation.
//
// The key is held only while none of our windows is focused. A global
// accelerator takes the keystroke at the OS level, so holding it while T3 Code
// is focused would starve the in-app keybinding of the very press it exists
// for. Focus releases the key; blur re-registers it once no window of ours
// (including a detached DevTools window) has focus. That "no window focused"
// check is the single source of truth: several renderers may push a chord,
// last writer wins, and all of them only ever see a press taken from another
// app.
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

function takenMessage(accelerator: string): string {
  return `${accelerator} is held by another app, so it only stops dictation while T3 Code is focused.`;
}

/**
 * Pure registration state, so tests drive it with a fake `globalShortcut`.
 * `desired` is the chord the renderer asked for; `held` is what the OS
 * currently routes to us, which is `desired` only while no window is focused.
 */
export class DictationGlobalStopRegistrar {
  readonly #shortcuts: GlobalShortcutLike;
  readonly #onPress: () => void;
  #desired: string | null = null;
  #held: string | null = null;
  #result: DesktopDictationGlobalStopResult = RELEASED;

  constructor(shortcuts: GlobalShortcutLike, onPress: () => void) {
    this.#shortcuts = shortcuts;
    this.#onPress = onPress;
  }

  get result(): DesktopDictationGlobalStopResult {
    return this.#result;
  }

  get held(): string | null {
    return this.#held;
  }

  /**
   * Null releases the key; the same chord twice is a no-op. While a window is
   * focused the key is only probed (register, then unregister) so the result
   * still says whether another app holds it.
   */
  apply(
    shortcut: KeybindingShortcut | null,
    windowFocused: boolean,
  ): DesktopDictationGlobalStopResult {
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
    // A chord that failed its probe is retried; a held one is a no-op.
    if (accelerator === this.#desired && this.#result.registered) return this.#result;
    this.#unhold();
    this.#desired = accelerator;
    const registered = this.#register(accelerator);
    if (registered && windowFocused) this.#unhold();
    this.#result = registered
      ? { registered: true, message: null }
      : { registered: false, message: takenMessage(accelerator) };
    return this.#result;
  }

  /** One of our windows took focus: the in-app keybinding owns the press now. */
  windowFocused(): void {
    this.#unhold();
  }

  /** No window of ours has focus any more: take the key back. */
  windowBlurred(): void {
    if (this.#desired === null || this.#held !== null) return;
    if (!this.#register(this.#desired)) {
      this.#result = { registered: false, message: takenMessage(this.#desired) };
    }
  }

  release(): void {
    this.#unhold();
    this.#desired = null;
    this.#result = RELEASED;
  }

  #register(accelerator: string): boolean {
    let registered = false;
    try {
      registered = this.#shortcuts.register(accelerator, this.#onPress);
    } catch {
      registered = false;
    }
    this.#held = registered ? accelerator : null;
    return registered;
  }

  #unhold(): void {
    if (this.#held !== null) {
      this.#shortcuts.unregister(this.#held);
      this.#held = null;
    }
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

function anyWindowFocused(): boolean {
  return Electron.BrowserWindow.getFocusedWindow() !== null;
}

export const make = Effect.gen(function* () {
  const registrar = new DictationGlobalStopRegistrar(Electron.globalShortcut, forwardPress);
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const onFocus = () => registrar.windowFocused();
  // Blur fires before the next window's focus when switching between our own
  // windows, so the check waits a moment; a zero sleep would run synchronously.
  const takeBackWhenUnfocused = Effect.sleep("1 millis").pipe(
    Effect.andThen(
      Effect.sync(() => {
        if (!anyWindowFocused()) registrar.windowBlurred();
      }),
    ),
  );
  const onBlur = () => {
    runFork(takeBackWhenUnfocused);
  };
  Electron.app.on("browser-window-focus", onFocus);
  Electron.app.on("browser-window-blur", onBlur);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Electron.app.removeListener("browser-window-focus", onFocus);
      Electron.app.removeListener("browser-window-blur", onBlur);
      registrar.release();
    }),
  );
  return DesktopDictationGlobalStop.of({
    apply: (shortcut) =>
      Effect.sync(() => registrar.apply(shortcut, anyWindowFocused())).pipe(
        Effect.withSpan("desktop.dictation.globalStop.apply"),
      ),
  });
});

export const layer = Layer.effect(DesktopDictationGlobalStop, make);
