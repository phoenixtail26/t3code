import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";

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
 * Adopt an external Claude Code CLI session as a new t3 thread. The server forks
 * the transcript file, so the CLI keeps its own and no confirmation is needed.
 * Shares dispatch/navigate/toast handling with `useForkThread`.
 */
export function useAdoptExternalSession() {
  const runOutcome = useThreadForkOutcome(threadForkEnvironment.adopt, ADOPT_OUTCOME_OPTIONS);

  return (input: {
    readonly environmentId: EnvironmentId;
    readonly sessionId: string;
    readonly modelSelection: ModelSelection;
  }) =>
    runOutcome({
      environmentId: input.environmentId,
      input: { sessionId: input.sessionId, modelSelection: input.modelSelection },
    });
}
