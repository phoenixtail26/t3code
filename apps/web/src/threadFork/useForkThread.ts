import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { SidebarThreadSummary } from "../types";
import { useRouter } from "@tanstack/react-router";
import { useRef } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { newThreadId } from "../lib/utils";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { waitForThreadShell } from "./useThreadForkOutcome";

/**
 * Sidebar "Fork thread": fork at the latest run through upstream's `thread.fork`
 * command, then open the new thread. Never touches the original, so no
 * confirmation. A ref guard makes a second click a no-op while one is in flight.
 */
export function useForkThread() {
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });
  const router = useRouter();
  const pendingRef = useRef(false);

  return async (
    thread: Pick<SidebarThreadSummary, "environmentId" | "id" | "title" | "latestRun">,
  ) => {
    if (pendingRef.current) return;
    const runId = thread.latestRun?.runId;
    if (runId === undefined) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to fork thread",
          description: "This thread has no completed response to fork from yet.",
        }),
      );
      return;
    }

    pendingRef.current = true;
    try {
      const targetThreadId = newThreadId();
      const targetThreadRef = scopeThreadRef(thread.environmentId, targetThreadId);
      const result = await forkThreadFromRun({
        environmentId: thread.environmentId,
        input: {
          sourceThreadId: thread.id,
          targetThreadId,
          runId,
          title: `${thread.title} fork`,
        },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to fork thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }

      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Thread forked",
          description: "Shares the original's working tree and branch.",
        }),
      );
      await waitForThreadShell(targetThreadRef);
      const navigationResult = await settlePromise(() =>
        router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(targetThreadRef),
        }),
      );
      if (navigationResult._tag === "Failure") {
        const error = squashAtomCommandFailure(navigationResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Created the fork, but could not open it",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    } finally {
      pendingRef.current = false;
    }
  };
}
