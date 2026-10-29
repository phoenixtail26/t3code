import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

/**
 * Thread forking is Claude-only, mirroring the server gate in
 * `apps/server/src/threadFork/wsHandlers.ts`. With no capability field on the
 * wire yet, the driver is found by scanning the environment's provider list
 * for the thread's `modelSelection.instanceId`.
 */
const CLAUDE_AGENT_DRIVER_KIND = "claudeAgent";

export function resolveThreadForkDriverKind(
  providersByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider>>,
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): string | null {
  const providers = providersByEnvironment.get(environmentId) ?? [];
  return providers.find((provider) => provider.instanceId === instanceId)?.driver ?? null;
}

export function canForkThread(
  providersByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider>>,
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): boolean {
  return (
    resolveThreadForkDriverKind(providersByEnvironment, environmentId, instanceId) ===
    CLAUDE_AGENT_DRIVER_KIND
  );
}
