import { MessageId, TurnId, type ExternalTranscriptEntry } from "@t3tools/contracts";

import type { TimelineEntry, WorkLogEntry } from "../session-logic";
import type { ChatMessage } from "../types";

/**
 * Maps a transcript's `ExternalTranscriptEntry[]` (server order) to
 * `TimelineEntry[]` for `MessagesTimeline`. Pure and order-preserving — the
 * server already interleaves messages and work items in file order, so this
 * must NOT re-sort (unlike `deriveTimelineEntries`, which merges several
 * live-session lists and has to).
 */
export function mapExternalTranscriptEntriesToTimeline(
  entries: ReadonlyArray<ExternalTranscriptEntry>,
): TimelineEntry[] {
  return entries.map((entry) => {
    if (entry.kind === "message") {
      const message: ChatMessage = {
        id: MessageId.make(entry.id),
        role: entry.role,
        text: entry.text,
        attachments: [],
        turnId: entry.turnId === null ? null : TurnId.make(entry.turnId),
        streaming: false,
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
      };
      return {
        id: entry.id,
        kind: "message",
        createdAt: entry.createdAt,
        message,
      };
    }

    // `exactOptionalPropertyTypes` forbids assigning `undefined` to optional
    // fields directly — omit the key entirely instead (matches the idiom in
    // session-logic.ts, e.g. `...(detail ? { detail } : {})`).
    const workEntry: WorkLogEntry = {
      id: entry.id,
      createdAt: entry.createdAt,
      turnId: entry.turnId === null ? null : TurnId.make(entry.turnId),
      label: entry.label,
      tone: entry.tone,
      ...(entry.detail !== null ? { detail: entry.detail } : {}),
      ...(entry.command !== null ? { command: entry.command } : {}),
      ...(entry.tone === "tool" ? { toolTitle: entry.label } : {}),
    };
    return {
      id: entry.id,
      kind: "work",
      createdAt: entry.createdAt,
      entry: workEntry,
    };
  });
}
