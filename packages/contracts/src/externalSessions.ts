import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

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
  getTranscript: "externalSessions.getTranscript",
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

/**
 * Read-only transcript view (Phase 4). The server maps a session's JSONL
 * records to a single ordered entry list: conversational messages plus
 * work items (thinking/tool activity), in file order. Lossy by design —
 * sidechain (subagent) records, attachments, and housekeeping records are
 * dropped; see DESIGN.md "transcript view mapping".
 */

export const ExternalTranscriptMessageEntry = Schema.Struct({
  kind: Schema.Literal("message"),
  /** Record uuid when present, else a synthesized stable id. Unique per transcript. */
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: IsoDateTime,
  /** Uuid of the user record that opened the turn; null before the first prompt. */
  turnId: Schema.NullOr(Schema.String),
});
export type ExternalTranscriptMessageEntry = typeof ExternalTranscriptMessageEntry.Type;

export const ExternalTranscriptWorkEntry = Schema.Struct({
  kind: Schema.Literal("work"),
  id: Schema.String,
  tone: Schema.Literals(["thinking", "tool", "error"]),
  /** Short row label: "Thinking", the tool name, or "Tool error". */
  label: Schema.String,
  /** Preview text: thinking excerpt, tool-input summary, or error excerpt. */
  detail: Schema.NullOr(Schema.String),
  /** Shell command line, for command-shaped tools (Bash). */
  command: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  turnId: Schema.NullOr(Schema.String),
});
export type ExternalTranscriptWorkEntry = typeof ExternalTranscriptWorkEntry.Type;

export const ExternalTranscriptEntry = Schema.Union([
  ExternalTranscriptMessageEntry,
  ExternalTranscriptWorkEntry,
]);
export type ExternalTranscriptEntry = typeof ExternalTranscriptEntry.Type;

export const ExternalSessionTranscript = Schema.Struct({
  sessionId: Schema.String,
  title: Schema.NullOr(Schema.String),
  state: ExternalSessionState,
  lastActivityAt: IsoDateTime,
  cwd: Schema.NullOr(Schema.String),
  entries: Schema.Array(ExternalTranscriptEntry),
  /** True when caps dropped the head of the file (large transcripts). */
  truncated: Schema.Boolean,
});
export type ExternalSessionTranscript = typeof ExternalSessionTranscript.Type;

export const ExternalSessionsGetTranscriptInput = Schema.Struct({
  sessionId: Schema.String,
});
export type ExternalSessionsGetTranscriptInput = typeof ExternalSessionsGetTranscriptInput.Type;

export class ExternalSessionTranscriptError extends Schema.TaggedErrorClass<ExternalSessionTranscriptError>()(
  "ExternalSessionTranscriptError",
  {
    /** "not-found": unknown/aged-out session; "read-failed": FS error. */
    reason: Schema.Literals(["not-found", "read-failed"]),
    message: TrimmedNonEmptyString,
  },
) {}
