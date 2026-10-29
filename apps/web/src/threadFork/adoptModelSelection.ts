import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

import {
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  isProviderInstancePickerReady,
} from "../providerInstances";

const CLAUDE_AGENT_DRIVER_KIND = "claudeAgent";

/**
 * The server rejects adopting onto any non-claudeAgent driver, so pick a ready
 * (else enabled and available) claudeAgent instance. No last-resort fallback:
 * returns null when none qualifies, which hides/disables the adopt action.
 */
export function resolveClaudeAgentAdoptModelSelection(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const claudeEntries = deriveProviderInstanceEntries(providers).filter(
    (entry) => entry.driverKind === CLAUDE_AGENT_DRIVER_KIND,
  );
  const entry =
    claudeEntries.find(isProviderInstancePickerReady) ??
    claudeEntries.find((candidate) => candidate.enabled && candidate.isAvailable);
  if (!entry) return null;

  const model = getDefaultProviderInstanceModel(providers, entry.instanceId);
  if (!model) return null;

  return { instanceId: entry.instanceId, model };
}
