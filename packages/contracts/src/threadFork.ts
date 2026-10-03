import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * External-session adoption — fork feature (FORK_PLAN_FORKING.md).
 *
 * Turns a Claude Code CLI session the radar found into a t3 thread bound to
 * that same session, with its visible transcript imported as history. Forking
 * a t3 thread uses upstream's native `thread.fork` command instead and has no
 * fork-owned contract.
 */

export const THREAD_FORK_WS_METHODS = {
  adoptExternalSession: "threads.adoptExternalSession",
} as const;

export const ThreadForkResult = Schema.Struct({
  /** The new thread, already created when the RPC returns. */
  threadId: ThreadId,
});
export type ThreadForkResult = typeof ThreadForkResult.Type;

/**
 * Adopt an external (radar) Claude Code session as a new t3 thread. The
 * session must match a known project by cwd; `modelSelection` picks the Claude
 * provider instance the thread continues on.
 */
export const ThreadAdoptExternalSessionInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
});
export type ThreadAdoptExternalSessionInput = typeof ThreadAdoptExternalSessionInput.Type;

export class ThreadForkError extends Schema.TaggedError<ThreadForkError>()("ThreadForkError", {
  /**
   * "not-found": unknown external session. "unsupported": the target provider
   * is not Claude, or the session already belongs to a t3 thread.
   * "no-project": the session's cwd matches no t3 project. "fork-failed": the
   * session transcript could not be read. "create-failed": the thread events
   * could not be written (no thread was left behind).
   */
  reason: Schema.Literals([
    "not-found",
    "unsupported",
    "no-project",
    "fork-failed",
    "create-failed",
  ]),
  message: TrimmedNonEmptyString,
}) {}
