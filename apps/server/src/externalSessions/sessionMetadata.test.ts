// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

import {
  deriveExternalSessionState,
  emptyMetadata,
  foldRecord,
  resolveTitle,
  WORKING_THRESHOLD_MS,
  type ExternalSessionMetadata,
} from "./sessionMetadata.ts";
import { parseTranscriptLine } from "./transcriptRecords.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixturesDir = NodePath.join(__dirname, "__fixtures__");

function readFixture(name: string): string {
  return NodeFS.readFileSync(NodePath.join(fixturesDir, name), "utf8");
}

/** Parse every line of a fixture (skipping unparseable lines, exactly as a
 *  real caller would) and fold them into a single metadata snapshot. */
function foldFixture(name: string): ExternalSessionMetadata {
  const lines = readFixture(name).split("\n");
  let meta = emptyMetadata();
  for (const line of lines) {
    const record = parseTranscriptLine(line);
    if (record !== null) meta = foldRecord(meta, record);
  }
  return meta;
}

describe("emptyMetadata", () => {
  it("starts with every field null", () => {
    expect(emptyMetadata()).toEqual({
      sessionId: null,
      cwd: null,
      customTitle: null,
      aiTitle: null,
      summaryTitle: null,
      lastTimestamp: null,
    });
  });
});

describe("foldRecord", () => {
  it("is latest-wins for every field", () => {
    let meta = emptyMetadata();
    meta = foldRecord(meta, { sessionId: "id-1", cwd: "/a" });
    meta = foldRecord(meta, { sessionId: "id-2" });
    meta = foldRecord(meta, { cwd: "/b" });
    expect(meta.sessionId).toBe("id-2");
    expect(meta.cwd).toBe("/b");
  });

  it("leaves fields untouched when a record does not carry them", () => {
    let meta = emptyMetadata();
    meta = foldRecord(meta, { sessionId: "id-1", cwd: "/a", timestamp: "t1" });
    meta = foldRecord(meta, {});
    expect(meta).toMatchObject({ sessionId: "id-1", cwd: "/a", lastTimestamp: "t1" });
  });

  it("routes each title kind to its own field, latest-wins within a kind", () => {
    let meta = emptyMetadata();
    meta = foldRecord(meta, { title: { kind: "ai", value: "first ai title" } });
    meta = foldRecord(meta, { title: { kind: "ai", value: "second ai title" } });
    meta = foldRecord(meta, { title: { kind: "summary", value: "a summary" } });
    meta = foldRecord(meta, { title: { kind: "custom", value: "a custom title" } });
    expect(meta.aiTitle).toBe("second ai title");
    expect(meta.summaryTitle).toBe("a summary");
    expect(meta.customTitle).toBe("a custom title");
  });
});

describe("resolveTitle", () => {
  it("returns null when no title has been set", () => {
    expect(resolveTitle(emptyMetadata())).toBeNull();
  });

  it("prefers customTitle over aiTitle and summaryTitle", () => {
    const meta: ExternalSessionMetadata = {
      ...emptyMetadata(),
      customTitle: "custom",
      aiTitle: "ai",
      summaryTitle: "summary",
    };
    expect(resolveTitle(meta)).toBe("custom");
  });

  it("prefers aiTitle over summaryTitle when there is no customTitle", () => {
    const meta: ExternalSessionMetadata = {
      ...emptyMetadata(),
      aiTitle: "ai",
      summaryTitle: "summary",
    };
    expect(resolveTitle(meta)).toBe("ai");
  });

  it("falls back to summaryTitle when there is no custom or ai title", () => {
    const meta: ExternalSessionMetadata = { ...emptyMetadata(), summaryTitle: "summary" };
    expect(resolveTitle(meta)).toBe("summary");
  });
});

describe("fixture-driven fold", () => {
  it("short-session.jsonl resolves sessionId, cwd, and the ai-title", () => {
    const meta = foldFixture("short-session.jsonl");
    expect(meta.sessionId).toBe("ae214dc4-2886-4e93-9bbf-47abcfde2db7");
    expect(meta.cwd).toBe("C:\\fake\\project");
    expect(resolveTitle(meta)).toBe("Explain parseConfig function");
  });

  it("tool-use.jsonl resolves sessionId, cwd, and the ai-title", () => {
    const meta = foldFixture("tool-use.jsonl");
    expect(meta.sessionId).toBe("7650d7a8-bbf5-4b7f-9716-327cdc3b1f91");
    expect(meta.cwd).toBe("C:\\fake\\project");
    expect(resolveTitle(meta)).toBe("Explain index.ts exports");
  });

  it("title-records.jsonl prefers the later custom-title over the earlier ai-title", () => {
    const meta = foldFixture("title-records.jsonl");
    expect(meta.sessionId).toBe("97dce91f-9c7d-4cdf-a15f-42707e1af5f4");
    expect(meta.cwd).toBe("C:\\fake\\project");
    expect(meta.aiTitle).toBe("Fix nightly build packaging failure");
    expect(meta.customTitle).toBe("nightly build bug");
    expect(resolveTitle(meta)).toBe("nightly build bug");
  });

  it("sidechain-main.jsonl resolves the main transcript's own sessionId, cwd, and ai-title", () => {
    const meta = foldFixture("sidechain-main.jsonl");
    expect(meta.sessionId).toBe("c0d3d903-b5be-44fd-a270-7fd1a290b9f2");
    expect(meta.cwd).toBe("C:\\fake\\project");
    expect(resolveTitle(meta)).toBe("Style review of parse.ts via subagent");
  });

  it("truncated-tail.jsonl still yields sessionId and cwd from the complete lines, with no title", () => {
    const meta = foldFixture("truncated-tail.jsonl");
    expect(meta.sessionId).toBe("d34db33f-0001-4a2a-9b9a-3f6d0c8e1a99");
    expect(meta.cwd).toBe("C:\\fake\\project");
    expect(resolveTitle(meta)).toBeNull();
  });
});

describe("deriveExternalSessionState", () => {
  it("is working when the file was touched now", () => {
    expect(deriveExternalSessionState(1_000_000, 1_000_000)).toBe("working");
  });

  it("is working just under the threshold", () => {
    const nowMs = 1_000_000;
    expect(deriveExternalSessionState(nowMs, nowMs - (WORKING_THRESHOLD_MS - 1))).toBe("working");
  });

  it("is idle exactly at the threshold", () => {
    const nowMs = 1_000_000;
    expect(deriveExternalSessionState(nowMs, nowMs - WORKING_THRESHOLD_MS)).toBe("idle");
  });

  it("is idle well past the threshold", () => {
    const nowMs = 1_000_000;
    expect(deriveExternalSessionState(nowMs, nowMs - WORKING_THRESHOLD_MS - 1)).toBe("idle");
  });
});
