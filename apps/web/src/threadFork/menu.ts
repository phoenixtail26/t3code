import type { ContextMenuItem } from "@t3tools/contracts";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";
import { canForkThread } from "./gate";

/**
 * Appends the fork's "Fork thread" entry to upstream's thread action menu.
 *
 * Upstream centralised the menu in `threadActionMenu.logic.ts` with a closed
 * `ThreadActionMenuId` union; widening it here keeps the fork item out of that
 * file entirely, so a caller only wraps the builder result in one line and the
 * resulting `"fork"` id still type-checks in its switch.
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

/**
 * Spread-style variant for menus built as inline arrays (the legacy sidebar):
 * `...forkThreadMenuEntry(serverConfigs, environmentId, instanceId)`.
 */
export function forkThreadMenuEntry(
  serverConfigs: Parameters<typeof canForkThread>[0],
  environmentId: Parameters<typeof canForkThread>[1],
  instanceId: Parameters<typeof canForkThread>[2],
): ReadonlyArray<typeof FORK_THREAD_MENU_ITEM> {
  return canForkThread(serverConfigs, environmentId, instanceId) ? [FORK_THREAD_MENU_ITEM] : [];
}
