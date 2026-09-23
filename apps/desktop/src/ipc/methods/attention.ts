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

/**
 * Notification sounds available from the OS. Windows ships a set of short WAVs
 * in %SystemRoot%\Media; other platforms return nothing and the renderer falls
 * back to the bundled sound.
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

/**
 * Restore/show/focus the main window. `window.focus()` in the renderer cannot
 * un-minimize or foreground a window on Windows, so a notification click that
 * navigates without this appears to do nothing.
 */
export const focusMainWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FOCUS_MAIN_WINDOW_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.attention.focusMainWindow")(function* () {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(window)) return;
    yield* electronWindow.reveal(window.value);
  }),
});
