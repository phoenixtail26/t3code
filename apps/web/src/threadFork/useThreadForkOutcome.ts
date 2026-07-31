import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadForkResult } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import { readLocalApi } from "../localApi";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Shared engine behind `useForkThread` (F5) and `useAdoptExternalSession`
 * (F6) — both RPCs return the same `{threadId}` success / `ThreadForkError`
 * failure shape (packages/contracts/src/threadFork.ts) and need the same
 * confirm -> dispatch -> navigate -> toast choreography
 * (FORK_PLAN_FORKING.md). A ref-based guard keeps a second call a no-op
 * while one is already in flight.
 */
export function useThreadForkOutcome<W extends { readonly environmentId: EnvironmentId }, E>(
  mutation: AtomCommand<W, ThreadForkResult, E>,
  options: { readonly failureTitle: string },
) {
  const runMutation = useAtomCommand(mutation, { reportFailure: false });
  const router = useRouter();
  const pendingRef = useRef(false);

  return useCallback(
    async (target: W, confirmMessage: string | null) => {
      if (pendingRef.current) return;

      if (confirmMessage !== null) {
        const localApi = readLocalApi();
        if (localApi) {
          const confirmationResult = await settlePromise(() =>
            localApi.dialogs.confirm(confirmMessage),
          );
          if (confirmationResult._tag === "Failure" || !confirmationResult.value) {
            return;
          }
        }
      }

      pendingRef.current = true;
      try {
        const result = await runMutation(target);
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: options.failureTitle,
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return;
        }

        const navigationResult = await settlePromise(() =>
          router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(target.environmentId, result.value.threadId),
            ),
          }),
        );
        if (navigationResult._tag === "Failure") {
          const error = squashAtomCommandFailure(navigationResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Created the thread, but could not open it",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      } finally {
        pendingRef.current = false;
      }
    },
    [runMutation, router, options.failureTitle],
  );
}
