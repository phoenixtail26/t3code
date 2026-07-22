// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ClaudeUsageSummary } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import {
  mapUpstreamLimits,
  newerEntry,
  readSharedCacheEntry,
  resolveClaudeCredentialsPath,
  resolveUsageCacheFilePath,
  writeSharedCacheEntry,
} from "./claudeUsage.ts";

describe("resolveClaudeCredentialsPath", () => {
  it("uses the default ~/.claude config dir when no homePath is set", () => {
    expect(resolveClaudeCredentialsPath("")).toBe(
      NodePath.join(NodeOS.homedir(), ".claude", ".credentials.json"),
    );
  });

  it("resolves a custom homePath with tilde expansion", () => {
    expect(resolveClaudeCredentialsPath("~/claude-work")).toBe(
      NodePath.join(NodeOS.homedir(), "claude-work", ".credentials.json"),
    );
  });
});

describe("resolveUsageCacheFilePath", () => {
  it("places the shared cache next to the credentials it is keyed by", () => {
    const credentialsPath = resolveClaudeCredentialsPath("");
    expect(resolveUsageCacheFilePath(credentialsPath)).toBe(
      NodePath.join(NodeOS.homedir(), ".claude", ".t3-usage-cache.json"),
    );
  });
});

describe("newerEntry", () => {
  const at = (fetchedAtMs: number) => ({
    fetchedAtMs,
    ttlMs: 60_000,
    summary: { status: "unavailable", checkedAt: "x", limits: [] } as ClaudeUsageSummary,
  });

  it("returns the defined entry when the other is missing", () => {
    expect(newerEntry(undefined, undefined)).toBeUndefined();
    expect(newerEntry(at(5), undefined)?.fetchedAtMs).toBe(5);
    expect(newerEntry(undefined, at(5))?.fetchedAtMs).toBe(5);
  });

  it("returns the entry with the later fetch time", () => {
    expect(newerEntry(at(10), at(20))?.fetchedAtMs).toBe(20);
    expect(newerEntry(at(30), at(20))?.fetchedAtMs).toBe(30);
  });
});

describe("shared cache entry round-trip", () => {
  let dir: string;
  let cacheFilePath: string;

  beforeEach(() => {
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-usage-"));
    cacheFilePath = NodePath.join(dir, ".t3-usage-cache.json");
  });

  afterEach(() => {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  const okEntry = {
    fetchedAtMs: 1_700_000_000_000,
    ttlMs: 60_000,
    summary: {
      status: "ok",
      checkedAt: "2026-07-22T00:00:00Z",
      limits: [
        {
          kind: "session",
          label: "Session",
          percent: 42,
          severity: "normal",
          resetsAt: null,
          isActive: true,
        },
      ],
    } as ClaudeUsageSummary,
  };

  it("returns undefined when no file exists yet", () => {
    expect(readSharedCacheEntry(cacheFilePath)).toBeUndefined();
  });

  it("round-trips a written entry through the file", () => {
    writeSharedCacheEntry(cacheFilePath, okEntry);
    expect(readSharedCacheEntry(cacheFilePath)).toEqual(okEntry);
  });

  it("ignores a corrupt or drifted-shape file rather than serving it", () => {
    NodeFS.writeFileSync(cacheFilePath, "{ not valid json", "utf8");
    expect(readSharedCacheEntry(cacheFilePath)).toBeUndefined();

    NodeFS.writeFileSync(cacheFilePath, JSON.stringify({ fetchedAtMs: 1, summary: {} }), "utf8");
    expect(readSharedCacheEntry(cacheFilePath)).toBeUndefined();
  });

  it("does not throw when the target directory is missing", () => {
    const missing = NodePath.join(dir, "nope", ".t3-usage-cache.json");
    expect(() => writeSharedCacheEntry(missing, okEntry)).not.toThrow();
    expect(readSharedCacheEntry(missing)).toBeUndefined();
  });
});

describe("mapUpstreamLimits", () => {
  it("maps the upstream limits array to the contract shape", () => {
    const limits = mapUpstreamLimits({
      limits: [
        {
          kind: "session",
          group: "session",
          percent: 13,
          severity: "normal",
          resets_at: "2026-07-18T03:49:59Z",
          scope: null,
          is_active: false,
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 87,
          severity: "warning",
          resets_at: "2026-07-19T17:59:59Z",
          scope: { model: { id: null, display_name: "Fable" }, surface: null },
          is_active: true,
        },
      ],
    });

    expect(limits).toEqual([
      {
        kind: "session",
        label: "Session",
        percent: 13,
        severity: "normal",
        resetsAt: "2026-07-18T03:49:59Z",
        isActive: false,
      },
      {
        kind: "weekly_scoped",
        label: "Week · Fable",
        percent: 87,
        severity: "warning",
        resetsAt: "2026-07-19T17:59:59Z",
        isActive: true,
      },
    ]);
  });

  it("derives severity from percent when upstream sends an unknown severity", () => {
    const limits = mapUpstreamLimits({
      limits: [
        { kind: "weekly_all", percent: 82, severity: "surprising", resets_at: null },
        { kind: "weekly_all", percent: 104, severity: undefined },
        { kind: "weekly_all", percent: 12 },
      ],
    });
    expect(limits.map((limit) => limit.severity)).toEqual(["warning", "error", "normal"]);
  });

  it("tolerates malformed payloads", () => {
    expect(mapUpstreamLimits(null)).toEqual([]);
    expect(mapUpstreamLimits({})).toEqual([]);
    expect(mapUpstreamLimits({ limits: "nope" })).toEqual([]);
    expect(mapUpstreamLimits({ limits: [null, 42, { percent: "NaN" }] })).toEqual([
      {
        kind: "unknown",
        label: "unknown",
        percent: 0,
        severity: "normal",
        resetsAt: null,
        isActive: false,
      },
    ]);
  });
});
