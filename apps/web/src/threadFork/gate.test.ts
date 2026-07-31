import type { EnvironmentId, ProviderInstanceId, ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canForkThread, resolveThreadForkDriverKind } from "./gate";

const environmentId = "env-1" as EnvironmentId;
const claudeInstanceId = "claude" as ProviderInstanceId;
const codexInstanceId = "codex" as ProviderInstanceId;

function serverConfigWithProviders(
  providers: ReadonlyArray<{ instanceId: ProviderInstanceId; driver: string }>,
): ServerConfig {
  return { providers } as unknown as ServerConfig;
}

describe("threadFork gate", () => {
  it("resolves the driver kind for a known instance", () => {
    const serverConfigs = new Map([
      [
        environmentId,
        serverConfigWithProviders([
          { instanceId: claudeInstanceId, driver: "claudeAgent" },
          { instanceId: codexInstanceId, driver: "codex" },
        ]),
      ],
    ]);

    expect(resolveThreadForkDriverKind(serverConfigs, environmentId, claudeInstanceId)).toBe(
      "claudeAgent",
    );
    expect(resolveThreadForkDriverKind(serverConfigs, environmentId, codexInstanceId)).toBe(
      "codex",
    );
  });

  it("returns null for an unknown instance or environment", () => {
    const serverConfigs = new Map([
      [
        environmentId,
        serverConfigWithProviders([{ instanceId: claudeInstanceId, driver: "claudeAgent" }]),
      ],
    ]);

    expect(
      resolveThreadForkDriverKind(serverConfigs, environmentId, "missing" as ProviderInstanceId),
    ).toBeNull();
    expect(resolveThreadForkDriverKind(new Map(), environmentId, claudeInstanceId)).toBeNull();
  });

  it("gates forking to claudeAgent instances only", () => {
    const serverConfigs = new Map([
      [
        environmentId,
        serverConfigWithProviders([
          { instanceId: claudeInstanceId, driver: "claudeAgent" },
          { instanceId: codexInstanceId, driver: "codex" },
        ]),
      ],
    ]);

    expect(canForkThread(serverConfigs, environmentId, claudeInstanceId)).toBe(true);
    expect(canForkThread(serverConfigs, environmentId, codexInstanceId)).toBe(false);
    expect(canForkThread(serverConfigs, environmentId, "missing" as ProviderInstanceId)).toBe(
      false,
    );
  });
});
