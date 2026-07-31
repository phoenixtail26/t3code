import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { threadForkEnvironment } from "./state";
import { useThreadForkOutcome } from "./useThreadForkOutcome";

/**
 * Fork a thread's Claude session into a new thread that keeps full
 * conversation context (FORK_PLAN_FORKING.md, increment F5). Mirrors
 * `useThreadActions.ts`'s `confirmAndDeleteThread` shape: confirm via
 * `localApi.dialogs.confirm`, dispatch, navigate on success, toast on
 * failure. `useThreadForkOutcome` shares that choreography (and its
 * in-flight guard) with `useAdoptExternalSession` (F6).
 */
export function useForkThread() {
  const runOutcome = useThreadForkOutcome(threadForkEnvironment.fork, {
    failureTitle: "Failed to fork thread",
  });

  return useCallback(
    (target: ScopedThreadRef, threadTitle: string) =>
      runOutcome(
        { environmentId: target.environmentId, input: { threadId: target.threadId } },
        [
          `Fork "${threadTitle}"?`,
          "The new thread keeps the full conversation so far and shares this thread's working tree and branch.",
          "Checkpoints and revert for messages before the fork stay with this thread.",
        ].join("\n"),
      ),
    [runOutcome],
  );
}
