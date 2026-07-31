import type { EnvironmentId, ExternalSessionState, ModelSelection } from "@t3tools/contracts";
import { useCallback } from "react";

import { formatRelativeTimeLabel } from "../timestampFormat";
import { threadForkEnvironment } from "./state";
import { useThreadForkOutcome } from "./useThreadForkOutcome";

/**
 * Adopt an external ("radar") Claude Code CLI session as a new t3 thread
 * (FORK_PLAN_FORKING.md, increment F6). The server forks the session's
 * transcript file rather than extending it, so the CLI keeps sole ownership
 * of its own file — the confirm copy makes that explicit. Shares the
 * confirm/dispatch/navigate/toast choreography with `useForkThread` (F5)
 * through `useThreadForkOutcome`.
 */
export function useAdoptExternalSession() {
  const runOutcome = useThreadForkOutcome(threadForkEnvironment.adopt, {
    failureTitle: "Failed to adopt session",
  });

  return useCallback(
    (input: {
      readonly environmentId: EnvironmentId;
      readonly sessionId: string;
      readonly modelSelection: ModelSelection;
      readonly title: string;
      readonly lastActivityAt: string;
      readonly state: ExternalSessionState;
    }) => {
      const lines = [
        `Adopt "${input.title}" as a new thread?`,
        `The session is copied into a new t3 thread with its full conversation context (last active ${formatRelativeTimeLabel(input.lastActivityAt)}). The original CLI session is left untouched — the CLI can keep using it.`,
      ];
      if (input.state === "working") {
        lines.push("This session looks active right now — adopting will snapshot it mid-work.");
      }

      return runOutcome(
        {
          environmentId: input.environmentId,
          input: { sessionId: input.sessionId, modelSelection: input.modelSelection },
        },
        lines.join("\n"),
      );
    },
    [runOutcome],
  );
}
