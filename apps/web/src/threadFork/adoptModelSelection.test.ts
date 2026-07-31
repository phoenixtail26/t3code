import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveClaudeAgentAdoptModelSelection } from "./adoptModelSelection";

function provider(overrides: {
  instanceId: string;
  driver: string;
  status?: "ready" | "warning" | "error" | "disabled";
  enabled?: boolean;
  availability?: "available" | "unavailable";
  models?: ReadonlyArray<{ slug: string; isCustom: boolean; isDefault?: boolean }>;
}): ServerProvider {
  return {
    instanceId: overrides.instanceId as ProviderInstanceId,
    driver: overrides.driver,
    displayName: overrides.driver,
    enabled: overrides.enabled ?? true,
    installed: true,
    status: overrides.status ?? "ready",
    availability: overrides.availability ?? "available",
    models: (
      overrides.models ?? [{ slug: "claude-default", isCustom: false, isDefault: true }]
    ).map((model) => ({ ...model, name: model.slug, capabilities: null })),
  } as unknown as ServerProvider;
}

describe("resolveClaudeAgentAdoptModelSelection", () => {
  it("returns null when no claudeAgent instance is configured", () => {
    const providers = [provider({ instanceId: "codex", driver: "codex" })];
    expect(resolveClaudeAgentAdoptModelSelection(providers)).toBeNull();
  });

  it("picks the ready claudeAgent instance and its default model", () => {
    const providers = [
      provider({ instanceId: "codex", driver: "codex" }),
      provider({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        models: [
          { slug: "claude-secondary", isCustom: false },
          { slug: "claude-primary", isCustom: false, isDefault: true },
        ],
      }),
    ];
    expect(resolveClaudeAgentAdoptModelSelection(providers)).toEqual({
      instanceId: "claudeAgent",
      model: "claude-primary",
    });
  });

  it("falls back to an enabled-but-not-ready claudeAgent instance over none at all", () => {
    const providers = [
      provider({
        instanceId: "claude_personal",
        driver: "claudeAgent",
        status: "warning",
        models: [{ slug: "claude-warn", isCustom: false, isDefault: true }],
      }),
    ];
    expect(resolveClaudeAgentAdoptModelSelection(providers)).toEqual({
      instanceId: "claude_personal",
      model: "claude-warn",
    });
  });

  it("returns null for a disabled claudeAgent instance with no other candidate", () => {
    const providers = [
      provider({
        instanceId: "claude_disabled",
        driver: "claudeAgent",
        enabled: false,
      }),
    ];
    // Unlike a new project's last-resort fallback, adopt has nowhere else to
    // go — a disabled-only claudeAgent instance hides the action instead of
    // handing back a selection that will fail to start.
    expect(resolveClaudeAgentAdoptModelSelection(providers)).toBeNull();
  });
});
