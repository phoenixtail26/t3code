import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId } from "./baseSchemas.ts";

/**
 * External Claude Code sessions ("the radar") — fork feature.
 *
 * The server watches `<claude-config>/projects/<slug>/*.jsonl` for sessions
 * driven outside t3code (plain CLI, IDE terminals), matches their cwd to
 * known t3 projects, and streams read-only state to the sidebar. See
 * `apps/server/src/externalSessions/DESIGN.md` and `FORK_PLAN_RADAR.md`.
 */

export const EXTERNAL_SESSIONS_WS_METHODS = {
  subscribe: "externalSessions.subscribe",
} as const;

/** State ladder (DESIGN.md): `working`/`idle` from file mtime; `waiting`
 * is the best-effort "blocked on a permission prompt" heuristic — a
 * dangling `tool_use` gone quiet in a session that can prompt. A
 * long-running approved tool is an accepted false positive. */
export const ExternalSessionState = Schema.Literals(["working", "idle", "waiting"]);
export type ExternalSessionState = typeof ExternalSessionState.Type;

export const ExternalSessionShell = Schema.Struct({
  /** Claude Code session UUID (the transcript filename). */
  sessionId: Schema.String,
  /** The t3 project this session's cwd matched. */
  projectId: ProjectId,
  /** Best-known title (custom > ai > summary), null when none recorded yet. */
  title: Schema.NullOr(Schema.String),
  state: ExternalSessionState,
  lastActivityAt: IsoDateTime,
  /** Recorded working directory, null until seen in the transcript. */
  cwd: Schema.NullOr(Schema.String),
});
export type ExternalSessionShell = typeof ExternalSessionShell.Type;

export const ExternalSessionsStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    sessions: Schema.Array(ExternalSessionShell),
  }),
  Schema.Struct({
    kind: Schema.Literal("upserted"),
    session: ExternalSessionShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("removed"),
    sessionId: Schema.String,
  }),
]);
export type ExternalSessionsStreamItem = typeof ExternalSessionsStreamItem.Type;

export const ExternalSessionsSubscribeInput = Schema.Struct({});
export type ExternalSessionsSubscribeInput = typeof ExternalSessionsSubscribeInput.Type;
