import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { threadForkEnvironment } from "./state";
import { useThreadForkOutcome } from "./useThreadForkOutcome";

// Module-level so the outcome callback keeps a stable identity across renders.
const FORK_OUTCOME_OPTIONS = {
  failureTitle: "Failed to fork thread",
  successToast: {
    title: "Thread forked",
    description: "Shares the original's working tree and branch.",
  },
} as const;

/**
 * Fork a thread's Claude session into a new thread that keeps full
 * conversation context (FORK_PLAN_FORKING.md, increment F5). Forking never
 * touches the original thread, so there is no confirmation step — dispatch,
 * navigate to the new thread, toast. `useThreadForkOutcome` shares that
 * choreography (and its in-flight guard) with `useAdoptExternalSession` (F6).
 */
export function useForkThread() {
  const runOutcome = useThreadForkOutcome(threadForkEnvironment.fork, FORK_OUTCOME_OPTIONS);

  return useCallback(
    (target: ScopedThreadRef) =>
      runOutcome({ environmentId: target.environmentId, input: { threadId: target.threadId } }),
    [runOutcome],
  );
}
