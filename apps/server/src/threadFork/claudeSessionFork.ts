// Fork feature: thread forking / external-session adoption (FORK_PLAN_FORKING.md).
//
// Wraps the Claude Agent SDK's standalone `forkSession` — an in-process
// filesystem operation (no CLI spawn): it copies the source transcript into a
// new session file with remapped UUIDs and returns the new session id, which
// is then resumable via the adapter's normal `resume` path.
//
// Config-dir resolution follows the radar precedent (ExternalSessionsWatcher,
// claudeUsage.ts): the SDK reads `CLAUDE_CONFIG_DIR ?? ~/.claude` from this
// process's env; custom per-instance `homePath` settings are not plumbed
// through. Forking a session that lives under a custom home fails with
// `not-found`, same as such sessions being invisible to the radar.
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ClaudeSessionForkError extends Schema.TaggedErrorClass<ClaudeSessionForkError>()(
  "ClaudeSessionForkError",
  {
    sourceSessionId: Schema.String,
    detail: Schema.String,
  },
) {}

/**
 * Copy `sourceSessionId`'s transcript into a fresh session, optionally sliced
 * up to (and including) `upToMessageId`. The source file is never modified.
 * `dir` narrows the search to one project directory (the session's cwd);
 * omitted, the SDK scans every project directory under the config dir.
 */
export const forkClaudeSession = Effect.fn("forkClaudeSession")(function* (input: {
  readonly sourceSessionId: string;
  readonly upToMessageId?: string;
  readonly dir?: string;
  readonly title?: string;
}) {
  const result = yield* Effect.tryPromise({
    try: () =>
      forkSession(input.sourceSessionId, {
        ...(input.dir !== undefined ? { dir: input.dir } : {}),
        ...(input.upToMessageId !== undefined ? { upToMessageId: input.upToMessageId } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
      }),
    catch: (cause) =>
      new ClaudeSessionForkError({
        sourceSessionId: input.sourceSessionId,
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  return { sessionId: result.sessionId };
});
