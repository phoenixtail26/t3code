// Fork feature: dictation. The one IPC method the renderer uses to hand the
// main process the chord to hold system-wide (or null to release it).
import { DesktopDictationGlobalStopResult, KeybindingShortcut } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeIpcMethod } from "../ipc/DesktopIpc.ts";
import { SET_DICTATION_GLOBAL_STOP_CHANNEL } from "./channels.ts";
import * as DesktopDictationGlobalStop from "./DesktopDictationGlobalStop.ts";

export const setDictationGlobalStop = makeIpcMethod({
  channel: SET_DICTATION_GLOBAL_STOP_CHANNEL,
  payload: Schema.NullOr(KeybindingShortcut),
  result: DesktopDictationGlobalStopResult,
  handler: Effect.fn("desktop.ipc.dictation.setGlobalStop")(function* (shortcut) {
    const globalStop = yield* DesktopDictationGlobalStop.DesktopDictationGlobalStop;
    return yield* globalStop.apply(shortcut);
  }),
});
