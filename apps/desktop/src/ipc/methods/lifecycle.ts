import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

/**
 * Relaunch via DesktopLifecycle: graceful shutdown, then a real process restart
 * (dev exits with the dev-runner's restart code), so rebuilt server/main code
 * loads and internal MCP servers re-authorize, not just the renderer bundle.
 */
export const relaunchApp = makeIpcMethod({
  channel: IpcChannels.RELAUNCH_APP_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.lifecycle.relaunchApp")(function* () {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* lifecycle.relaunch("newBuildAvailable");
  }),
});
