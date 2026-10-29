import type { ContextMenuItem } from "@t3tools/contracts";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";

/**
 * Appends the "Fork thread" entry to upstream's thread action menu. Widening
 * the closed `ThreadActionMenuId` union here keeps the fork item out of
 * `threadActionMenu.logic.ts`.
 */
export type ForkThreadActionMenuId = ThreadActionMenuId | "fork";

const FORK_THREAD_MENU_ITEM = { id: "fork", label: "Fork thread", icon: "git-branch" } as const;

export function withForkThreadMenuItem(
  items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
  canFork: boolean,
): ReadonlyArray<ContextMenuItem<ForkThreadActionMenuId>> {
  // Fork is Claude-only (FORK_PLAN_FORKING.md #6) — see threadFork/gate.ts.
  return canFork ? [...items, FORK_THREAD_MENU_ITEM] : items;
}
