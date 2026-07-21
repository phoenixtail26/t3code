import type { ExternalTranscriptEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mapExternalTranscriptEntriesToTimeline } from "./ExternalSessionView.logic";

function messageEntry(
  overrides: Partial<Extract<ExternalTranscriptEntry, { kind: "message" }>> = {},
): Extract<ExternalTranscriptEntry, { kind: "message" }> {
  return {
    kind: "message",
    id: "entry-message-1",
    role: "user",
    text: "hello",
    createdAt: "2026-07-20T10:00:00.000Z",
    turnId: null,
    ...overrides,
  };
}

function workEntry(
  overrides: Partial<Extract<ExternalTranscriptEntry, { kind: "work" }>> = {},
): Extract<ExternalTranscriptEntry, { kind: "work" }> {
  return {
    kind: "work",
    id: "entry-work-1",
    tone: "tool",
    label: "Bash",
    detail: null,
    command: null,
    createdAt: "2026-07-20T10:00:01.000Z",
    turnId: null,
    ...overrides,
  };
}

describe("mapExternalTranscriptEntriesToTimeline", () => {
  it("maps a user message entry to a ChatMessage-shaped timeline row", () => {
    const [row] = mapExternalTranscriptEntriesToTimeline([
      messageEntry({ id: "m-1", role: "user", text: "hi there", turnId: "turn-1" }),
    ]);

    expect(row).toEqual({
      id: "m-1",
      kind: "message",
      createdAt: "2026-07-20T10:00:00.000Z",
      message: {
        id: "m-1",
        role: "user",
        text: "hi there",
        attachments: [],
        turnId: "turn-1",
        streaming: false,
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
      },
    });
  });

  it("maps an assistant message entry, preserving role", () => {
    const [row] = mapExternalTranscriptEntriesToTimeline([
      messageEntry({ id: "m-2", role: "assistant", text: "reply" }),
    ]);

    expect(row?.kind).toBe("message");
    expect(row && row.kind === "message" ? row.message.role : null).toBe("assistant");
  });

  it("carries turnId through as a branded value when present", () => {
    const [row] = mapExternalTranscriptEntriesToTimeline([
      messageEntry({ id: "m-3", turnId: "turn-42" }),
    ]);

    expect(row && row.kind === "message" ? row.message.turnId : undefined).toBe("turn-42");
  });

  it("keeps turnId null when the entry has no turn", () => {
    const [row] = mapExternalTranscriptEntriesToTimeline([messageEntry({ turnId: null })]);

    expect(row && row.kind === "message" ? row.message.turnId : undefined).toBeNull();
  });

  it.each(["thinking", "tool", "error"] as const)(
    "maps a %s-tone work entry with the tone preserved",
    (tone) => {
      const [row] = mapExternalTranscriptEntriesToTimeline([
        workEntry({ id: `w-${tone}`, tone, label: "Something happened" }),
      ]);

      expect(row?.kind).toBe("work");
      expect(row && row.kind === "work" ? row.entry.tone : null).toBe(tone);
    },
  );

  it("sets toolTitle to the label only for tool-tone entries", () => {
    const [toolRow] = mapExternalTranscriptEntriesToTimeline([
      workEntry({ tone: "tool", label: "Read" }),
    ]);
    const [thinkingRow] = mapExternalTranscriptEntriesToTimeline([
      workEntry({ tone: "thinking", label: "Thinking" }),
    ]);

    expect(toolRow && toolRow.kind === "work" ? toolRow.entry.toolTitle : undefined).toBe("Read");
    expect(
      thinkingRow && thinkingRow.kind === "work" ? thinkingRow.entry.toolTitle : undefined,
    ).toBeUndefined();
  });

  it("maps null detail/command to undefined, and preserves non-null values", () => {
    const [withNulls] = mapExternalTranscriptEntriesToTimeline([
      workEntry({ detail: null, command: null }),
    ]);
    const [withValues] = mapExternalTranscriptEntriesToTimeline([
      workEntry({ detail: "some detail", command: "ls -la" }),
    ]);

    expect(
      withNulls && withNulls.kind === "work" ? withNulls.entry.detail : "missing",
    ).toBeUndefined();
    expect(
      withNulls && withNulls.kind === "work" ? withNulls.entry.command : "missing",
    ).toBeUndefined();
    expect(withValues && withValues.kind === "work" ? withValues.entry.detail : null).toBe(
      "some detail",
    );
    expect(withValues && withValues.kind === "work" ? withValues.entry.command : null).toBe(
      "ls -la",
    );
  });

  it("preserves server order exactly, without re-sorting by createdAt", () => {
    const entries: ExternalTranscriptEntry[] = [
      messageEntry({ id: "later", createdAt: "2026-07-20T12:00:00.000Z" }),
      workEntry({ id: "earlier", createdAt: "2026-07-20T09:00:00.000Z" }),
      messageEntry({ id: "middle", createdAt: "2026-07-20T10:30:00.000Z" }),
    ];

    const rows = mapExternalTranscriptEntriesToTimeline(entries);

    expect(rows.map((row) => row.id)).toEqual(["later", "earlier", "middle"]);
  });

  it("returns an empty array for an empty transcript", () => {
    expect(mapExternalTranscriptEntriesToTimeline([])).toEqual([]);
  });
});
