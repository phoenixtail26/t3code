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
}

export function emptyMetadata(): ExternalSessionMetadata {
  return {
    sessionId: null,
    cwd: null,
    customTitle: null,
    aiTitle: null,
    summaryTitle: null,
    lastTimestamp: null,
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

  return next;
}

/** Title ladder: `customTitle` > `aiTitle` > `summaryTitle` > `null` (the
 *  UI falls back further, e.g. to the session id prefix). */
export function resolveTitle(meta: ExternalSessionMetadata): string | null {
  return meta.customTitle ?? meta.aiTitle ?? meta.summaryTitle ?? null;
}

/** MVP has exactly these two states; mtime is the only liveness signal
 *  that cannot lie (see DESIGN.md for the post-MVP "waiting on
 *  permission" heuristic, deliberately out of scope here). */
export function deriveExternalSessionState(nowMs: number, mtimeMs: number): "working" | "idle" {
  return nowMs - mtimeMs < WORKING_THRESHOLD_MS ? "working" : "idle";
}
