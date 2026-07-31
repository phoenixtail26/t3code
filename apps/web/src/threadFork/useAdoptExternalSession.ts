import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { useCallback } from "react";

import { threadForkEnvironment } from "./state";
import { useThreadForkOutcome } from "./useThreadForkOutcome";

// Module-level so the outcome callback keeps a stable identity across renders.
const ADOPT_OUTCOME_OPTIONS = {
  failureTitle: "Failed to adopt session",
  successToast: {
    title: "Session adopted",
    description: "The CLI's own session is untouched.",
  },
} as const;

/**
 * Adopt an external ("radar") Claude Code CLI session as a new t3 thread
 * (FORK_PLAN_FORKING.md, increment F6). The server forks the session's
 * transcript file rather than extending it, so the CLI keeps sole ownership
 * of its own file — adoption is non-destructive and needs no confirmation.
 * Shares the dispatch/navigate/toast choreography with `useForkThread` (F5)
 * through `useThreadForkOutcome`.
 */
export function useAdoptExternalSession() {
  const runOutcome = useThreadForkOutcome(threadForkEnvironment.adopt, ADOPT_OUTCOME_OPTIONS);

  return useCallback(
    (input: {
      readonly environmentId: EnvironmentId;
      readonly sessionId: string;
      readonly modelSelection: ModelSelection;
    }) =>
      runOutcome({
        environmentId: input.environmentId,
        input: { sessionId: input.sessionId, modelSelection: input.modelSelection },
      }),
    [runOutcome],
  );
}
