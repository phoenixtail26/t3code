import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

import {
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  isProviderInstancePickerReady,
} from "../providerInstances";

const CLAUDE_AGENT_DRIVER_KIND = "claudeAgent";

/**
 * Adopting an external session (F6) always continues on a Claude provider
 * instance — the server rejects any other driver (see
 * `apps/server/src/threadFork/wsHandlers.ts`'s `adoptExternalSession`,
 * `reason: "unsupported"` for non-claudeAgent). The client picks the
 * instance the same way a new thread picks its default
 * (`resolveDefaultNewProjectModelSelection` in `../modelSelection.ts`) —
 * ready first, else enabled+available — but scoped to claudeAgent
 * instances only, and with no further last-resort fallback: unlike a new
 * project (which must land on *some* provider), an adopted session has
 * nowhere else to go, so a disabled or unavailable claudeAgent instance is
 * treated the same as none configured. Returns null in that case, which
 * callers use to hide/disable the adopt action.
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
