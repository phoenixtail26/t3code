import type { ContextMenuItem } from "@t3tools/contracts";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";

/**
 * Appends the fork's "Fork thread" entry to upstream's thread action menu.
 *
 * Upstream centralised the menu in `threadActionMenu.logic.ts` with a closed
 * `ThreadActionMenuId` union; widening it here keeps the fork item out of that
 * file entirely, so a caller only wraps the builder result in one line and the
 * resulting `"fork"` id still type-checks in its switch.
 */
export type ForkThreadActionMenuId = ThreadActionMenuId | "fork";

export function withForkThreadMenuItem(
  items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
  canFork: boolean,
): ReadonlyArray<ContextMenuItem<ForkThreadActionMenuId>> {
  // Fork is Claude-only (FORK_PLAN_FORKING.md #6) — see threadFork/gate.ts.
  return canFork ? [...items, { id: "fork", label: "Fork thread", icon: "git-branch" }] : items;
}
