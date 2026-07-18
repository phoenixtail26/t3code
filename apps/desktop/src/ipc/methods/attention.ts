import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const AttentionStateInput = Schema.Struct({
  waiting: Schema.Boolean,
});

const OVERLAY_SIZE = 16;

/**
 * A filled dot for the taskbar overlay, drawn as a raw BGRA bitmap so no image
 * asset ships with the app. `app.setBadgeCount` is macOS/Linux only, so Windows
 * needs an overlay icon to show anything at all.
 */
function makeAttentionOverlay(): Electron.NativeImage {
  const buffer = Buffer.alloc(OVERLAY_SIZE * OVERLAY_SIZE * 4);
  const centre = (OVERLAY_SIZE - 1) / 2;
  const radius = centre - 0.5;
  for (let y = 0; y < OVERLAY_SIZE; y += 1) {
    for (let x = 0; x < OVERLAY_SIZE; x += 1) {
      const offset = (y * OVERLAY_SIZE + x) * 4;
      const inside = (x - centre) ** 2 + (y - centre) ** 2 <= radius ** 2;
      // BGRA, premultiplied alpha: an orange dot matching the "needs you" tone.
      buffer[offset] = inside ? 0x22 : 0;
      buffer[offset + 1] = inside ? 0x88 : 0;
      buffer[offset + 2] = inside ? 0xf9 : 0;
      buffer[offset + 3] = inside ? 0xff : 0;
    }
  }
  return Electron.nativeImage.createFromBitmap(buffer, {
    width: OVERLAY_SIZE,
    height: OVERLAY_SIZE,
  });
}

let cachedOverlay: Electron.NativeImage | null = null;

export const setAttentionState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_ATTENTION_STATE_CHANNEL,
  payload: AttentionStateInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.attention.setAttentionState")(function* (input) {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(window)) return;

    yield* Effect.sync(() => {
      const target = window.value;
      if (input.waiting) {
        cachedOverlay ??= makeAttentionOverlay();
        target.setOverlayIcon(cachedOverlay, "A thread needs your attention");
        // Windows stops the flash itself once the window is focused, so this
        // never needs an explicit "stop" on the happy path.
        target.flashFrame(true);
        return;
      }
      target.setOverlayIcon(null, "");
      target.flashFrame(false);
    });
  }),
});
