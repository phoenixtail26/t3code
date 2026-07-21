/**
 * Pure mapping of a Claude Code session JSONL file's contents to the
 * read-only transcript view. No Effect, no IO — see `DESIGN.md`
 * ("Transcript view mapping (Phase 4)") for the full spec this implements.
 *
 * Deliberately separate from `transcriptRecords.ts` (the hot-path metadata
 * parser used by the watcher): this module retains `message.content` and
 * only runs on demand, when a client asks to view one session's transcript.
 * It mirrors that module's defensive parsing style — every line is parsed
 * independently, oversized/invalid/truncated lines are skipped without ever
 * throwing.
 */
import type { ExternalTranscriptEntry } from "@t3tools/contracts";

import { MAX_RECORD_BYTES } from "./transcriptRecords.ts";

/** Read caps applied by the caller (`wsHandlers.ts`) before content ever
 *  reaches this module: only the trailing `MAX_TRANSCRIPT_READ_BYTES` of a
 *  large file are read, dropping the leading partial line. */
export const MAX_TRANSCRIPT_READ_BYTES = 10 * 1024 * 1024;

/** Hard cap on emitted entries — huge sessions keep only the most recent
 *  activity; older entries are dropped from the head. */
export const MAX_TRANSCRIPT_ENTRIES = 2000;

/** Fallback `createdAt` when the file carries no timestamp at all. */
const DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

const THINKING_EXCERPT_MAX_CHARS = 2000;
const TOOL_RESULT_EXCERPT_MAX_CHARS = 500;
const GENERIC_EXCERPT_MAX_CHARS = 200;

interface PendingMessage {
  readonly kind: "message";
  readonly role: "user" | "assistant";
  text: string;
}

interface PendingWork {
  readonly kind: "work";
  readonly tone: "thinking" | "tool" | "error";
  readonly label: string;
  readonly detail: string | null;
  readonly command: string | null;
}

type PendingEntry = PendingMessage | PendingWork;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse a single JSONL line into its raw object form (unlike
 * `transcriptRecords.parseTranscriptLine`, this keeps every field — the
 * transcript view needs `message.content`). Never throws: trims the line,
 * then returns `null` for anything that is not a usable JSON object (empty,
 * oversized, invalid JSON, non-object, array).
 */
function safeParseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  // Skip oversized lines without ever calling JSON.parse on them — real
  // files contain pasted-attachment lines up to ~350KB.
  if (trimmed.length > MAX_RECORD_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function capText(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Excerpt of a `tool_result` block's `content` for the error work entry:
 *  a plain string is used as-is; an array of content blocks (the shape seen
 *  when a subagent's final answer is inlined) has its `text` blocks
 *  concatenated; anything else falls back to a compact JSON stringification. */
function excerptToolResultContent(content: unknown, maxChars: number): string {
  if (typeof content === "string") return capText(content, maxChars);
  if (Array.isArray(content)) {
    const text = content
      .filter(isRecordObject)
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n\n");
    if (text.length > 0) return capText(text, maxChars);
    return capText(safeStringify(content), maxChars);
  }
  return capText(safeStringify(content), maxChars);
}

/** Per-tool `tool_use.input` summary: shell tools get a `command`; file,
 *  search, agent, and web tools get a targeted `detail`; anything else gets
 *  a capped compact JSON excerpt. */
function summarizeToolInput(
  name: string,
  input: unknown,
): { readonly detail: string | null; readonly command: string | null } {
  const inputObj = isRecordObject(input) ? input : {};
  switch (name) {
    case "Bash":
    case "PowerShell": {
      const command = typeof inputObj.command === "string" ? inputObj.command : null;
      return { command, detail: null };
    }
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const detail = typeof inputObj.file_path === "string" ? inputObj.file_path : null;
      return { command: null, detail };
    }
    case "Grep":
    case "Glob": {
      const detail = typeof inputObj.pattern === "string" ? inputObj.pattern : null;
      return { command: null, detail };
    }
    case "Agent":
    case "Task": {
      const description = typeof inputObj.description === "string" ? inputObj.description : null;
      const prompt = typeof inputObj.prompt === "string" ? inputObj.prompt : null;
      const detail =
        description !== null
          ? description
          : prompt !== null
            ? capText(prompt, GENERIC_EXCERPT_MAX_CHARS)
            : null;
      return { command: null, detail };
    }
    case "WebFetch":
    case "WebSearch": {
      const url = typeof inputObj.url === "string" ? inputObj.url : null;
      const query = typeof inputObj.query === "string" ? inputObj.query : null;
      return { command: null, detail: url ?? query };
    }
    default:
      return { command: null, detail: capText(safeStringify(input), GENERIC_EXCERPT_MAX_CHARS) };
  }
}

/** `type:"user"` records: string content is the message verbatim; array
 *  content concatenates `text` blocks into one message entry (in block
 *  order, so interleaving with `tool_result` blocks is preserved) and turns
 *  `tool_result` blocks with `is_error:true` into error work entries.
 *  Non-error `tool_result` blocks are dropped. */
function processUserRecord(obj: Record<string, unknown>): PendingEntry[] {
  const message = obj.message;
  if (!isRecordObject(message)) return [];
  const content = message.content;

  if (typeof content === "string") {
    return content.trim().length > 0 ? [{ kind: "message", role: "user", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const pending: PendingEntry[] = [];
  const textParts: string[] = [];
  let messagePlaceholder: PendingMessage | null = null;

  for (const rawBlock of content) {
    if (!isRecordObject(rawBlock)) continue;
    const blockType = rawBlock.type;
    if (blockType === "text" && typeof rawBlock.text === "string") {
      textParts.push(rawBlock.text);
      if (messagePlaceholder === null) {
        messagePlaceholder = { kind: "message", role: "user", text: "" };
        pending.push(messagePlaceholder);
      }
    } else if (blockType === "tool_result" && rawBlock.is_error === true) {
      pending.push({
        kind: "work",
        tone: "error",
        label: "Tool error",
        detail: excerptToolResultContent(rawBlock.content, TOOL_RESULT_EXCERPT_MAX_CHARS),
        command: null,
      });
    }
    // Non-error tool_result blocks, and any other block type, are dropped.
  }

  if (messagePlaceholder !== null) {
    const text = textParts.join("\n\n");
    if (text.trim().length > 0) {
      messagePlaceholder.text = text;
    } else {
      pending.splice(pending.indexOf(messagePlaceholder), 1);
    }
  }

  return pending;
}

/** `type:"assistant"` records: content blocks are walked in order. All
 *  `text` blocks collapse into a single message entry positioned at the
 *  first text block seen; `thinking` and `tool_use` blocks each become a
 *  work entry at their position. */
function processAssistantRecord(obj: Record<string, unknown>): PendingEntry[] {
  const message = obj.message;
  if (!isRecordObject(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];

  const pending: PendingEntry[] = [];
  const textParts: string[] = [];
  let messagePlaceholder: PendingMessage | null = null;

  for (const rawBlock of content) {
    if (!isRecordObject(rawBlock)) continue;
    const blockType = rawBlock.type;
    if (blockType === "text" && typeof rawBlock.text === "string") {
      textParts.push(rawBlock.text);
      if (messagePlaceholder === null) {
        messagePlaceholder = { kind: "message", role: "assistant", text: "" };
        pending.push(messagePlaceholder);
      }
    } else if (blockType === "thinking") {
      const thinking = typeof rawBlock.thinking === "string" ? rawBlock.thinking : "";
      pending.push({
        kind: "work",
        tone: "thinking",
        label: "Thinking",
        detail: capText(thinking, THINKING_EXCERPT_MAX_CHARS),
        command: null,
      });
    } else if (blockType === "tool_use") {
      const name = typeof rawBlock.name === "string" ? rawBlock.name : "Tool";
      const { detail, command } = summarizeToolInput(name, rawBlock.input);
      pending.push({ kind: "work", tone: "tool", label: name, detail, command });
    }
    // Any other block type is dropped.
  }

  if (messagePlaceholder !== null) {
    const text = textParts.join("\n\n");
    if (text.trim().length > 0) {
      messagePlaceholder.text = text;
    } else {
      pending.splice(pending.indexOf(messagePlaceholder), 1);
    }
  }

  return pending;
}

/**
 * Map a full session JSONL file's contents to the ordered transcript entry
 * list. Lossy by design (DESIGN.md): sidechain (subagent) records, `isMeta`
 * records, housekeeping/standalone records, and non-`user`/`assistant`
 * types are skipped. File order is preserved — callers must not re-sort.
 */
export function mapTranscriptContent(content: string): {
  readonly entries: ExternalTranscriptEntry[];
  readonly entryCapTripped: boolean;
} {
  const lines = content.split("\n");

  // Prescan: the first timestamp seen anywhere in the file (any record
  // type), used as the fallback for entries emitted before any timestamped
  // record has been processed in the main pass below.
  let fileFirstTimestamp: string | null = null;
  for (const line of lines) {
    const obj = safeParseLine(line);
    if (obj === null) continue;
    if (typeof obj.timestamp === "string" && obj.timestamp.length > 0) {
      fileFirstTimestamp = obj.timestamp;
      break;
    }
  }
  const fallbackTimestamp = fileFirstTimestamp ?? DEFAULT_TIMESTAMP;

  const entries: ExternalTranscriptEntry[] = [];
  let lastSeenTimestamp: string | null = null;
  let currentTurnId: string | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const obj = safeParseLine(lines[lineIndex] ?? "");
    if (obj === null) continue;
    if (obj.isSidechain === true || obj.isMeta === true) continue;

    const type = obj.type;
    if (type !== "user" && type !== "assistant") continue;

    const uuid = typeof obj.uuid === "string" ? obj.uuid : undefined;
    const baseId = uuid ?? `line-${lineIndex}`;

    const recordTimestamp =
      typeof obj.timestamp === "string" && obj.timestamp.length > 0 ? obj.timestamp : undefined;
    if (recordTimestamp !== undefined) lastSeenTimestamp = recordTimestamp;
    const effectiveTimestamp = recordTimestamp ?? lastSeenTimestamp ?? fallbackTimestamp;

    const pending = type === "user" ? processUserRecord(obj) : processAssistantRecord(obj);
    if (pending.length === 0) continue;

    // Only a user record carrying a non-empty message opens a new turn; the
    // new turn id applies to that message entry and everything after it
    // (including any other entries emitted from this same record).
    if (type === "user" && pending.some((entry) => entry.kind === "message")) {
      currentTurnId = baseId;
    }
    const turnId = currentTurnId;

    pending.forEach((entry, blockIndex) => {
      const id = pending.length > 1 ? `${baseId}#${blockIndex}` : baseId;
      if (entry.kind === "message") {
        entries.push({
          kind: "message",
          id,
          role: entry.role,
          text: entry.text,
          createdAt: effectiveTimestamp,
          turnId,
        });
      } else {
        entries.push({
          kind: "work",
          id,
          tone: entry.tone,
          label: entry.label,
          detail: entry.detail,
          command: entry.command,
          createdAt: effectiveTimestamp,
          turnId,
        });
      }
    });
  }

  if (entries.length > MAX_TRANSCRIPT_ENTRIES) {
    return {
      entries: entries.slice(entries.length - MAX_TRANSCRIPT_ENTRIES),
      entryCapTripped: true,
    };
  }
  return { entries, entryCapTripped: false };
}
