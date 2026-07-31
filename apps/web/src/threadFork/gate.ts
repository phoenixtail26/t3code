import type { EnvironmentId, ProviderInstanceId, ServerConfig } from "@t3tools/contracts";

/**
 * Thread forking is Claude-only (FORK_PLAN_FORKING.md design decision #6) —
 * mirrors the server's own gate in
 * `apps/server/src/threadFork/wsHandlers.ts` (`driverKind !== "claudeAgent"`
 * -> `reason: "unsupported"`). The client has no capability transport field
 * yet, so this resolves the driver the same way `ChatView.tsx` already does
 * for its own instanceId lookups: scanning the environment's provider
 * snapshot list for the thread's `modelSelection.instanceId`.
 */
const CLAUDE_AGENT_DRIVER_KIND = "claudeAgent";

export function resolveThreadForkDriverKind(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): string | null {
  const providers = serverConfigs.get(environmentId)?.providers ?? [];
  return providers.find((provider) => provider.instanceId === instanceId)?.driver ?? null;
}

export function canForkThread(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): boolean {
  return (
    resolveThreadForkDriverKind(serverConfigs, environmentId, instanceId) ===
    CLAUDE_AGENT_DRIVER_KIND
  );
}
