// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { mapUpstreamLimits, resolveClaudeCredentialsPath } from "./claudeUsage.ts";

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
