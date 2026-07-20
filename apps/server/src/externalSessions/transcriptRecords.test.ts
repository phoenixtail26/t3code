// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

import { MAX_RECORD_BYTES, parseTranscriptLine, splitJsonlChunk } from "./transcriptRecords.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixturesDir = NodePath.join(__dirname, "__fixtures__");

function readFixture(name: string): string {
  return NodeFS.readFileSync(NodePath.join(fixturesDir, name), "utf8");
}

describe("parseTranscriptLine", () => {
  it("returns null for an empty line", () => {
    expect(parseTranscriptLine("")).toBeNull();
    expect(parseTranscriptLine("   \t  ")).toBeNull();
  });

  it("returns null for a non-JSON line without throwing", () => {
    expect(() => parseTranscriptLine("not json at all {")).not.toThrow();
    expect(parseTranscriptLine("not json at all {")).toBeNull();
  });

  it("returns null for an array line", () => {
    expect(parseTranscriptLine("[1,2,3]")).toBeNull();
  });

  it("returns null for a bare number line", () => {
    expect(parseTranscriptLine("42")).toBeNull();
  });

  it("returns null for a bare null/string JSON value", () => {
    expect(parseTranscriptLine("null")).toBeNull();
    expect(parseTranscriptLine('"hello"')).toBeNull();
  });

  it("returns null for an oversized line without attempting JSON.parse", () => {
    const oversized = `{"cwd":"${"x".repeat(MAX_RECORD_BYTES + 1)}"}`;
    expect(oversized.length).toBeGreaterThan(MAX_RECORD_BYTES);
    let parseCalled = false;
    const originalParse = JSON.parse;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (JSON as any).parse = (...args: Parameters<typeof JSON.parse>) => {
      parseCalled = true;
      return originalParse(...args);
    };
    try {
      expect(() => parseTranscriptLine(oversized)).not.toThrow();
      expect(parseTranscriptLine(oversized)).toBeNull();
      expect(parseCalled).toBe(false);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("returns an all-undefined record for a structurally valid line with no MVP fields", () => {
    expect(parseTranscriptLine('{"type":"queue-operation","op":"clear"}')).toEqual({});
  });

  it("extracts camelCase sessionId only, ignoring snake_case session_id", () => {
    const record = parseTranscriptLine(
      '{"sessionId":"camel-case-id","session_id":"snake-case-id"}',
    );
    expect(record).toEqual({ sessionId: "camel-case-id" });
  });

  it("extracts cwd and timestamp", () => {
    const record = parseTranscriptLine(
      '{"cwd":"C:\\\\fake\\\\project","timestamp":"2026-07-18T09:15:03.100Z"}',
    );
    expect(record).toEqual({ cwd: "C:\\fake\\project", timestamp: "2026-07-18T09:15:03.100Z" });
  });

  it("extracts a custom-title record", () => {
    const record = parseTranscriptLine(
      '{"type":"custom-title","customTitle":"renamed session","sessionId":"abc"}',
    );
    expect(record?.title).toEqual({ kind: "custom", value: "renamed session" });
  });

  it("extracts an ai-title record", () => {
    const record = parseTranscriptLine('{"type":"ai-title","aiTitle":"generated title"}');
    expect(record?.title).toEqual({ kind: "ai", value: "generated title" });
  });

  it("extracts a summary record (vanilla CLI title mechanism)", () => {
    const record = parseTranscriptLine('{"type":"summary","summary":"a summary title"}');
    expect(record?.title).toEqual({ kind: "summary", value: "a summary title" });
  });

  it("does not extract a title when the type doesn't match the field present", () => {
    // Wrong type tag for the field: must not be picked up as a title.
    expect(
      parseTranscriptLine('{"type":"user","aiTitle":"should not be used"}')?.title,
    ).toBeUndefined();
  });

  it("parses every complete line of the truncated-tail fixture without throwing, and null on the truncated final line", () => {
    const raw = readFixture("truncated-tail.jsonl");
    const lines = raw.split("\n");
    // Fixture has no trailing newline: the last element of split("\n") is
    // the truncated, non-JSON-terminated final line.
    expect(lines.length).toBeGreaterThan(1);

    const results = lines.map((line) => {
      let result: ReturnType<typeof parseTranscriptLine>;
      expect(() => {
        result = parseTranscriptLine(line);
      }).not.toThrow();
      return result!;
    });

    expect(results[results.length - 1]).toBeNull();
    expect(results.slice(0, -1).some((record) => record !== null)).toBe(true);
  });

  describe.each([
    "short-session.jsonl",
    "tool-use.jsonl",
    "title-records.jsonl",
    "sidechain-main.jsonl",
  ])("fixture %s", (fixtureName) => {
    it("parses every line without throwing", () => {
      const lines = readFixture(fixtureName)
        .split("\n")
        .filter((line) => line.length > 0);
      for (const line of lines) {
        expect(() => parseTranscriptLine(line)).not.toThrow();
      }
    });
  });
});

describe("splitJsonlChunk", () => {
  it("splits a single chunk with no carry", () => {
    const { lines, carry } = splitJsonlChunk("a\nb\nc\n", "");
    expect(lines).toEqual(["a", "b", "c"]);
    expect(carry).toBe("");
  });

  it("returns the trailing partial segment as carry", () => {
    const { lines, carry } = splitJsonlChunk("a\nb\npart", "");
    expect(lines).toEqual(["a", "b"]);
    expect(carry).toBe("part");
  });

  it("prepends carry to the next chunk", () => {
    const first = splitJsonlChunk("ab\ncd", "");
    expect(first.lines).toEqual(["ab"]);
    expect(first.carry).toBe("cd");

    const second = splitJsonlChunk("ef\n", first.carry);
    expect(second.lines).toEqual(["cdef"]);
    expect(second.carry).toBe("");
  });

  it("strips a trailing \\r from complete lines (tolerates CRLF)", () => {
    const { lines, carry } = splitJsonlChunk("a\r\nb\r\npart", "");
    expect(lines).toEqual(["a", "b"]);
    expect(carry).toBe("part");
  });

  it("does not trim non-\\r whitespace from complete lines", () => {
    const { lines } = splitJsonlChunk("  a  \n", "");
    expect(lines).toEqual(["  a  "]);
  });

  it("handles an empty chunk with existing carry", () => {
    const { lines, carry } = splitJsonlChunk("", "leftover");
    expect(lines).toEqual([]);
    expect(carry).toBe("leftover");
  });

  it("carry round-trips across arbitrary chunk sizes, matching a single-shot split", () => {
    const raw = readFixture("tool-use.jsonl");

    const singleShot = splitJsonlChunk(raw, "");
    expect(singleShot.carry).toBe("");

    for (const chunkSize of [1, 3, 7, 64]) {
      let carry = "";
      const collected: string[] = [];
      for (let offset = 0; offset < raw.length; offset += chunkSize) {
        const chunk = raw.slice(offset, offset + chunkSize);
        const result = splitJsonlChunk(chunk, carry);
        collected.push(...result.lines);
        carry = result.carry;
      }
      // The fixture ends with a trailing newline, so the final carry is "".
      expect(carry).toBe("");
      expect(collected).toEqual(singleShot.lines);
    }
  });

  it("carry round-trips for a fixture with no trailing newline (truncated tail)", () => {
    const raw = readFixture("truncated-tail.jsonl");
    const singleShot = splitJsonlChunk(raw, "");

    let carry = "";
    const collected: string[] = [];
    const chunkSize = 7;
    for (let offset = 0; offset < raw.length; offset += chunkSize) {
      const chunk = raw.slice(offset, offset + chunkSize);
      const result = splitJsonlChunk(chunk, carry);
      collected.push(...result.lines);
      carry = result.carry;
    }
    expect(collected).toEqual(singleShot.lines);
    expect(carry).toBe(singleShot.carry);
  });
});
