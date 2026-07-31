import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

/**
 * Thread forking — fork feature (FORK_PLAN_FORKING.md).
 *
 * Forks a Claude-driven thread's CLI session into a fresh session file (full
 * conversation context preserved) and creates a new thread seeded to resume
 * it. The parent thread — its session file, checkpoints, and history — is
 * never modified. v1 forks the whole session; forking from a specific
 * message is a later increment.
 */

export const THREAD_FORK_WS_METHODS = {
  forkThread: "threads.forkThread",
  adoptExternalSession: "threads.adoptExternalSession",
} as const;

export const ThreadForkInput = Schema.Struct({
  /** The thread whose Claude session should be forked. */
  threadId: ThreadId,
});
export type ThreadForkInput = typeof ThreadForkInput.Type;

export const ThreadForkResult = Schema.Struct({
  /** The newly created thread, ready for its first turn. */
  threadId: ThreadId,
});
export type ThreadForkResult = typeof ThreadForkResult.Type;

/**
 * Adopt an external (radar) Claude CLI session as a t3 thread. The session
 * file is forked, never extended, so the CLI's own transcript is left for
 * the CLI; the adopted thread continues on the copy. The server derives the
 * project from the session's cwd (same matching as the radar sidebar);
 * the client supplies the model selection the new thread should use, same
 * as every other thread-creation path.
 */
export const ThreadAdoptExternalSessionInput = Schema.Struct({
  /** Claude Code session UUID, as shown in the radar. */
  sessionId: Schema.String,
  modelSelection: ModelSelection,
});
export type ThreadAdoptExternalSessionInput = typeof ThreadAdoptExternalSessionInput.Type;

export class ThreadForkError extends Schema.TaggedErrorClass<ThreadForkError>()("ThreadForkError", {
  /**
   * "not-found": unknown thread / external session. "unsupported": the
   * source's provider is not Claude (or the session already belongs to a
   * t3 thread). "no-session": thread has no resumable Claude session yet.
   * "no-project": the external session's cwd matches no t3 project.
   * "fork-failed": the session transcript could not be forked.
   * "create-failed": the forked session exists but thread creation or
   * cursor seeding failed (no new thread was left behind).
   */
  reason: Schema.Literals([
    "not-found",
    "unsupported",
    "no-session",
    "no-project",
    "fork-failed",
    "create-failed",
  ]),
  message: TrimmedNonEmptyString,
}) {}
