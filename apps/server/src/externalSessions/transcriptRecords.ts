/**
 * Pure parsing of Claude Code session JSONL lines (DESIGN.md "Pure parser
 * modules"). The on-disk format is undocumented and per-line, so parsing uses
 * defensive `typeof` guards like `../provider/claudeUsage.ts`, not a schema library.
 */

/** Lines longer than this are skipped without ever reaching `JSON.parse` —
 *  real files contain pasted-attachment lines up to ~350KB; this is a
 *  generous cap above that observed maximum. */
export const MAX_RECORD_BYTES = 1024 * 1024;

export interface ExternalSessionTitle {
  readonly kind: "custom" | "ai" | "summary";
  readonly value: string;
}

/** The radar-relevant projection of a transcript line — everything else in
 *  the record is ignored. A structurally valid line that carries none of
 *  these fields still parses to `{}` (all fields `undefined`); only lines
 *  that fail to parse at all return `null`. */
export interface ExternalSessionRecord {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly timestamp?: string;
  readonly title?: ExternalSessionTitle;
  /** Set on conversational (`user`/`assistant`) records only: `true` when an
   *  assistant record issues `tool_use` blocks whose results have not been
   *  seen yet, `false` when a record resolves/supersedes them. Standalone
   *  housekeeping records leave it `undefined` (no opinion). */
  readonly pendingToolUse?: boolean;
  /** From standalone `permission-mode` records (restated each turn):
   *  `default` / `acceptEdits` / `plan` / `bypassPermissions`. */
  readonly permissionMode?: string;
}

function hasToolUseBlock(message: unknown): boolean {
  if (message === null || typeof message !== "object") return false;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      block !== null &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "tool_use",
  );
}

/**
 * Parse a single JSONL line into its MVP-relevant projection. Never
 * throws: trims the line, then returns `null` for anything that is not a
 * usable JSON object (empty, oversized, invalid JSON, non-object, array).
 */
export function parseTranscriptLine(line: string): ExternalSessionRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  // Skip oversized lines without ever calling JSON.parse on them.
  if (trimmed.length > MAX_RECORD_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const record: {
    sessionId?: string;
    cwd?: string;
    timestamp?: string;
    title?: ExternalSessionTitle;
    pendingToolUse?: boolean;
    permissionMode?: string;
  } = {};

  // camelCase `sessionId` only — snake_case `session_id` is a different,
  // unrelated field observed in the same records and must be ignored.
  if (typeof obj.sessionId === "string") record.sessionId = obj.sessionId;
  if (typeof obj.cwd === "string") record.cwd = obj.cwd;
  if (typeof obj.timestamp === "string") record.timestamp = obj.timestamp;

  const type = obj.type;
  if (type === "custom-title" && typeof obj.customTitle === "string") {
    record.title = { kind: "custom", value: obj.customTitle };
  } else if (type === "ai-title" && typeof obj.aiTitle === "string") {
    record.title = { kind: "ai", value: obj.aiTitle };
  } else if (type === "summary" && typeof obj.summary === "string") {
    record.title = { kind: "summary", value: obj.summary };
  } else if (type === "permission-mode" && typeof obj.permissionMode === "string") {
    record.permissionMode = obj.permissionMode;
  }

  // An assistant record issuing `tool_use` blocks leaves the session blocked until
  // any later conversational record. Sidechain (subagent) records say nothing
  // about the session's own turn.
  if (obj.isSidechain !== true) {
    if (type === "assistant") {
      record.pendingToolUse = hasToolUseBlock(obj.message);
    } else if (type === "user") {
      record.pendingToolUse = false;
    }
  }

  return record;
}

/**
 * Carry-aware line splitter for the byte-offset tailer: splits `carry + chunk`
 * on `\n`, returns the complete lines plus the trailing partial segment as the
 * new carry. Strips a trailing `\r` (the format is unversioned); otherwise verbatim.
 */
export function splitJsonlChunk(chunk: string, carry: string): { lines: string[]; carry: string } {
  const combined = carry + chunk;
  const segments = combined.split("\n");
  const newCarry = segments.pop() ?? "";
  const lines = segments.map((segment) =>
    segment.endsWith("\r") ? segment.slice(0, -1) : segment,
  );
  return { lines, carry: newCarry };
}
