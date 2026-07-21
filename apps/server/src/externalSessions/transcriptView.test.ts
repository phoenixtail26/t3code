// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

import { MAX_TRANSCRIPT_ENTRIES, mapTranscriptContent } from "./transcriptView.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixturesDir = NodePath.join(__dirname, "__fixtures__");

function readFixture(name: string): string {
  return NodeFS.readFileSync(NodePath.join(fixturesDir, name), "utf8");
}

describe("mapTranscriptContent", () => {
  describe("fixtures", () => {
    it("short-session.jsonl: user + assistant text messages, correct roles/order/turnId, housekeeping skipped", () => {
      const { entries, entryCapTripped } = mapTranscriptContent(readFixture("short-session.jsonl"));

      expect(entryCapTripped).toBe(false);
      expect(entries).toEqual([
        {
          kind: "message",
          id: "295be05d-4996-4b9f-ac28-2c70fae7a690",
          role: "user",
          text: "What does the parseConfig function do?",
          createdAt: "2026-07-18T09:15:03.100Z",
          turnId: "295be05d-4996-4b9f-ac28-2c70fae7a690",
        },
        {
          kind: "message",
          id: "53116664-b315-4d9b-b6d2-be98c0aedef1",
          role: "assistant",
          text: "It reads the JSON config file from disk and validates that the required fields are present before returning the parsed object.",
          createdAt: "2026-07-18T09:15:05.400Z",
          turnId: "295be05d-4996-4b9f-ac28-2c70fae7a690",
        },
      ]);
    });

    it("tool-use.jsonl: thinking + tool_use work entries with correct tone/label/command-or-detail; non-error tool_result produces no entry; interleaving order preserved", () => {
      const { entries } = mapTranscriptContent(readFixture("tool-use.jsonl"));

      expect(entries.map((entry) => entry.kind)).toEqual([
        "message",
        "work",
        "work",
        "work",
        "message",
      ]);

      const userTurnId = "1c5522bf-13e6-4588-b409-1fa9a731f65f";
      expect(entries.every((entry) => entry.turnId === userTurnId)).toBe(true);

      const [userMsg, thinking, readTool, bashTool, assistantMsg] = entries;
      expect(userMsg).toMatchObject({
        kind: "message",
        role: "user",
        text: "Read src/index.ts and tell me what it exports.",
      });
      expect(thinking).toMatchObject({ kind: "work", tone: "thinking", label: "Thinking" });
      expect(readTool).toMatchObject({
        kind: "work",
        tone: "tool",
        label: "Read",
        detail: "C:\\fake\\project\\src\\index.ts",
        command: null,
      });
      expect(bashTool).toMatchObject({
        kind: "work",
        tone: "tool",
        label: "Bash",
        detail: null,
        command: "echo hello",
      });
      expect(assistantMsg).toMatchObject({
        kind: "message",
        role: "assistant",
        text: "src/index.ts exports loadConfig() and a version constant.",
      });
    });

    it("sidechain-main.jsonl: main-file records map correctly (Agent tool_use summarized; inlined subagent tool_result produces no entry)", () => {
      const { entries } = mapTranscriptContent(readFixture("sidechain-main.jsonl"));

      expect(entries.map((entry) => entry.kind)).toEqual(["message", "work", "message"]);
      expect(entries[1]).toMatchObject({
        kind: "work",
        tone: "tool",
        label: "Agent",
        detail: "Style review",
        command: null,
      });
    });

    it("truncated-tail.jsonl: does not throw; records up to the truncated final line are mapped", () => {
      let result: ReturnType<typeof mapTranscriptContent> | undefined;
      expect(() => {
        result = mapTranscriptContent(readFixture("truncated-tail.jsonl"));
      }).not.toThrow();

      expect(result!.entries.map((entry) => entry.kind)).toEqual(["message", "work"]);
      expect(result!.entries[0]).toMatchObject({
        kind: "message",
        role: "user",
        text: "Summarize the changes in the last commit.",
      });
      expect(result!.entries[1]).toMatchObject({
        kind: "work",
        tone: "tool",
        label: "Bash",
        command: "git log -1 --stat",
      });
    });

    it("dangling-tool-use.jsonl: a dangling tool_use produces a work entry without crashing", () => {
      let result: ReturnType<typeof mapTranscriptContent> | undefined;
      expect(() => {
        result = mapTranscriptContent(readFixture("dangling-tool-use.jsonl"));
      }).not.toThrow();

      expect(result!.entries.map((entry) => entry.kind)).toEqual(["message", "message", "work"]);
      // The assistant record emits 2 entries (text + tool_use), so both get
      // a block-index suffix on the shared record uuid.
      expect(result!.entries[1]?.id).toBe("3f85f24c-9e02-4c6e-a22e-63491f8ad9ee#0");
      expect(result!.entries[2]).toMatchObject({
        id: "3f85f24c-9e02-4c6e-a22e-63491f8ad9ee#1",
        kind: "work",
        tone: "tool",
        label: "Bash",
        command: "git push origin release",
      });
    });
  });

  describe("synthetic cases", () => {
    it("maps a string message.content to a single user message entry", () => {
      const line = JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Hello world" },
      });
      const { entries } = mapTranscriptContent(`${line}\n`);

      expect(entries).toEqual([
        {
          kind: "message",
          id: "u1",
          role: "user",
          text: "Hello world",
          createdAt: "2026-01-01T00:00:00.000Z",
          turnId: "u1",
        },
      ]);
    });

    it("skips records with isMeta:true", () => {
      const line = JSON.stringify({
        type: "user",
        uuid: "u2",
        isMeta: true,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "should be skipped" },
      });
      const { entries } = mapTranscriptContent(`${line}\n`);
      expect(entries).toEqual([]);
    });

    it("skips records with isSidechain:true", () => {
      const line = JSON.stringify({
        type: "assistant",
        uuid: "u3",
        isSidechain: true,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "skip me" }] },
      });
      const { entries } = mapTranscriptContent(`${line}\n`);
      expect(entries).toEqual([]);
    });

    it("turns an is_error tool_result block into an error work entry", () => {
      const line = JSON.stringify({
        type: "user",
        uuid: "u4",
        timestamp: "2026-01-01T00:01:00.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }],
        },
      });
      const { entries } = mapTranscriptContent(`${line}\n`);

      expect(entries).toEqual([
        {
          kind: "work",
          id: "u4",
          tone: "error",
          label: "Tool error",
          detail: "boom",
          command: null,
          createdAt: "2026-01-01T00:01:00.000Z",
          turnId: null,
        },
      ]);
    });

    it("assigns unique, block-suffixed ids across a multi-block record", () => {
      const line = JSON.stringify({
        type: "assistant",
        uuid: "u5",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "t" },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a" } },
            { type: "text", text: "done" },
          ],
        },
      });
      const { entries } = mapTranscriptContent(`${line}\n`);

      expect(entries.map((entry) => entry.id)).toEqual(["u5#0", "u5#1", "u5#2"]);
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
      expect(entries.map((entry) => entry.kind)).toEqual(["work", "work", "message"]);
    });

    it("caps entries at MAX_TRANSCRIPT_ENTRIES, keeping the most recent and reporting entryCapTripped", () => {
      const total = MAX_TRANSCRIPT_ENTRIES + 500;
      const lines: string[] = [];
      for (let i = 0; i < total; i++) {
        lines.push(
          JSON.stringify({
            type: "assistant",
            uuid: `a${i}`,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: { role: "assistant", content: [{ type: "text", text: `msg ${i}` }] },
          }),
        );
      }
      const { entries, entryCapTripped } = mapTranscriptContent(lines.join("\n"));

      expect(entryCapTripped).toBe(true);
      expect(entries).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
      expect(entries[0]?.id).toBe("a500");
      expect(entries[entries.length - 1]?.id).toBe(`a${total - 1}`);
    });

    it("falls back to the epoch timestamp when the file carries no timestamps at all", () => {
      const lines = [
        JSON.stringify({
          type: "user",
          uuid: "nu1",
          message: { role: "user", content: "hi" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "na1",
          message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
        }),
      ];
      const { entries } = mapTranscriptContent(lines.join("\n"));

      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        expect(entry.createdAt).toBe("1970-01-01T00:00:00.000Z");
      }
    });

    it("skips malformed lines (invalid JSON, arrays, empty lines) without throwing", () => {
      const validUser = JSON.stringify({
        type: "user",
        uuid: "mv1",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "valid" },
      });
      const validAssistant = JSON.stringify({
        type: "assistant",
        uuid: "mv2",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
      });
      const content = ["not json {", validUser, "[1,2,3]", "", validAssistant].join("\n");

      let result: ReturnType<typeof mapTranscriptContent> | undefined;
      expect(() => {
        result = mapTranscriptContent(content);
      }).not.toThrow();

      expect(result!.entries.map((entry) => entry.id)).toEqual(["mv1", "mv2"]);
    });
  });
});
