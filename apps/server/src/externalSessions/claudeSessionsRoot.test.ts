// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { resolveClaudeSessionsRoot } from "./claudeSessionsRoot.ts";

describe("resolveClaudeSessionsRoot", () => {
  it("uses the default ~/.claude config dir when no homePath is set", () => {
    expect(resolveClaudeSessionsRoot("")).toBe(
      NodePath.join(NodeOS.homedir(), ".claude", "projects"),
    );
  });

  it("falls back to the default config dir for a whitespace-only homePath", () => {
    expect(resolveClaudeSessionsRoot("   ")).toBe(
      NodePath.join(NodeOS.homedir(), ".claude", "projects"),
    );
  });

  it("expands a bare ~ homePath", () => {
    expect(resolveClaudeSessionsRoot("~")).toBe(NodePath.join(NodeOS.homedir(), "projects"));
  });

  it("expands a ~/custom homePath", () => {
    expect(resolveClaudeSessionsRoot("~/custom")).toBe(
      NodePath.join(NodeOS.homedir(), "custom", "projects"),
    );
  });

  it("resolves an absolute homePath as-is", () => {
    const absolutePath = NodePath.resolve(NodeOS.homedir(), "claude-work");
    expect(resolveClaudeSessionsRoot(absolutePath)).toBe(NodePath.join(absolutePath, "projects"));
  });
});
