import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

/**
 * Relaunch the desktop app on renderer request. Goes through DesktopLifecycle,
 * so it gracefully shuts the app down (persisting sessions) and then does a
 * real process restart — production relaunches with the same argv, development
 * exits with the dev-runner's restart code. Used by the "new build available"
 * pill so the reload picks up rebuilt server/main code and re-authorizes
 * internal MCP servers, not just the renderer bundle.
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
