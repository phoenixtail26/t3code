/**
 * Pure fold/derivation over `ExternalSessionRecord`s. No Effect, no IO —
 * see `DESIGN.md` ("Pure parser modules") for the full spec this mirrors.
 */

import { type ExternalSessionRecord } from "./transcriptRecords.ts";

/** `working` iff the file was written to within this many ms of "now":
 *  long thinking/tool gaps can write nothing for a minute-plus, so the
 *  threshold is wide on purpose — the cost of the width is only that an
 *  ended session shows "working" for up to this long after it finished. */
export const WORKING_THRESHOLD_MS = 120_000;

/** A dangling `tool_use` younger than this is treated as a tool still
 *  running (`working`); older, as blocked on the permission prompt
 *  (`waiting`). The 2026-07-21 tail survey (195 recent transcripts) found
 *  NO content-level marker for a pending permission prompt — a blocked
 *  session and a slow tool are byte-identical, and mtime staleness is the
 *  only differing axis. Dangling `tool_use` essentially never survives at
 *  rest in normal operation (1/195, and that one was live mid-call), so a
 *  stale one is a strong attention signal; the accepted false positive is
 *  a genuinely long-running approved tool in a prompting session. */
export const WAITING_THRESHOLD_MS = 30_000;

/** `permission-mode` value under which a session can never be blocked on
 *  an approval prompt — suppresses `waiting` entirely (headless/yolo
 *  sessions run long tools all the time). */
const BYPASS_PERMISSION_MODE = "bypassPermissions";

/** Accumulated, latest-wins projection of a session's transcript so far.
 *  All fields are nullable — a session may not have reached a line that
 *  sets a given field yet (or, for titles, may never get one). */
export interface ExternalSessionMetadata {
  readonly sessionId: string | null;
  readonly cwd: string | null;
  readonly customTitle: string | null;
  readonly aiTitle: string | null;
  readonly summaryTitle: string | null;
  readonly lastTimestamp: string | null;
  /** `true` while the transcript's last conversational record leaves a
   *  `tool_use` unanswered (see `parseTranscriptLine`). */
  readonly pendingToolUse: boolean;
  readonly permissionMode: string | null;
}

export function emptyMetadata(): ExternalSessionMetadata {
  return {
    sessionId: null,
    cwd: null,
    customTitle: null,
    aiTitle: null,
    summaryTitle: null,
    lastTimestamp: null,
    pendingToolUse: false,
    permissionMode: null,
  };
}

/** Fold one more parsed record into accumulated metadata. Every field is
 *  latest-wins: a record that doesn't carry a given field leaves the
 *  existing value untouched. */
export function foldRecord(
  meta: ExternalSessionMetadata,
  record: ExternalSessionRecord,
): ExternalSessionMetadata {
  const next: { -readonly [K in keyof ExternalSessionMetadata]: ExternalSessionMetadata[K] } = {
    ...meta,
  };

  if (record.sessionId !== undefined) next.sessionId = record.sessionId;
  if (record.cwd !== undefined) next.cwd = record.cwd;
  if (record.timestamp !== undefined) next.lastTimestamp = record.timestamp;
  if (record.title !== undefined) {
    if (record.title.kind === "custom") next.customTitle = record.title.value;
    else if (record.title.kind === "ai") next.aiTitle = record.title.value;
    else next.summaryTitle = record.title.value;
  }
  if (record.pendingToolUse !== undefined) next.pendingToolUse = record.pendingToolUse;
  if (record.permissionMode !== undefined) next.permissionMode = record.permissionMode;

  return next;
}

/** Title ladder: `customTitle` > `aiTitle` > `summaryTitle` > `null` (the
 *  UI falls back further, e.g. to the session id prefix). */
export function resolveTitle(meta: ExternalSessionMetadata): string | null {
  return meta.customTitle ?? meta.aiTitle ?? meta.summaryTitle ?? null;
}

/** State ladder (DESIGN.md "state ladder"): `waiting` outranks the mtime
 *  rungs and persists until the dangling `tool_use` is answered — an
 *  overnight-blocked session stays flagged. `working`/`idle` remain pure
 *  mtime signals. */
export function deriveExternalSessionState(
  nowMs: number,
  mtimeMs: number,
  meta: ExternalSessionMetadata,
): "working" | "idle" | "waiting" {
  const staleMs = nowMs - mtimeMs;
  if (
    meta.pendingToolUse &&
    meta.permissionMode !== BYPASS_PERMISSION_MODE &&
    staleMs >= WAITING_THRESHOLD_MS
  ) {
    return "waiting";
  }
  return staleMs < WORKING_THRESHOLD_MS ? "working" : "idle";
}
