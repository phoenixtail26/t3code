// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
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

/**
 * Notification sounds available from the OS. Windows ships a set of short WAVs
 * in %SystemRoot%\Media; other platforms return nothing and the renderer falls
 * back to its built-in synthesized chime.
 */
const NotificationSoundSchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
});

function systemSoundDirectory(env: NodeJS.ProcessEnv): string | null {
  const systemRoot = env["SystemRoot"] ?? env["windir"];
  if (systemRoot === undefined || systemRoot.length === 0) return null;
  return NodePath.win32.join(systemRoot, "Media");
}

export const listNotificationSounds = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_NOTIFICATION_SOUNDS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(NotificationSoundSchema),
  handler: Effect.fn("desktop.ipc.attention.listNotificationSounds")(function* () {
    const platform = yield* HostProcessPlatform;
    const env = yield* HostProcessEnvironment;
    return yield* Effect.sync(() => {
      if (platform !== "win32") return [];
      const directory = systemSoundDirectory(env);
      if (directory === null) return [];
      try {
        return NodeFS.readdirSync(directory)
          .filter((entry) => entry.toLowerCase().endsWith(".wav"))
          .map((entry) => ({
            name: entry.replace(/\.wav$/i, ""),
            path: NodePath.win32.join(directory, entry),
          }));
      } catch {
        return [];
      }
    });
  }),
});

export const readNotificationSound = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.READ_NOTIFICATION_SOUND_CHANNEL,
  payload: Schema.String,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.attention.readNotificationSound")(function* (soundPath) {
    const env = yield* HostProcessEnvironment;
    return yield* Effect.sync(() => {
      // Only ever read from the OS sound directory: this channel takes a path
      // from the renderer, so without this it would be an arbitrary file-read
      // primitive.
      const directory = systemSoundDirectory(env);
      if (directory === null) return null;
      const resolved = NodePath.win32.resolve(soundPath);
      const withinDirectory =
        resolved.toLowerCase().startsWith(`${NodePath.win32.resolve(directory).toLowerCase()}\\`) &&
        resolved.toLowerCase().endsWith(".wav");
      if (!withinDirectory) return null;
      try {
        return NodeFS.readFileSync(resolved).toString("base64");
      } catch {
        return null;
      }
    });
  }),
});

/**
 * Seconds since the last OS-level user input. Lets the renderer report the user
 * as present even while t3code sits in the background (working in another app),
 * which is what keeps the phone quiet while they are at the desk.
 */
export const getSystemIdleSeconds = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_SYSTEM_IDLE_SECONDS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Number,
  handler: Effect.fn("desktop.ipc.attention.getSystemIdleSeconds")(function* () {
    return yield* Effect.sync(() => Electron.powerMonitor.getSystemIdleTime());
  }),
});

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
