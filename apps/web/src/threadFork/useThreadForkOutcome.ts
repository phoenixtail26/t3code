import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadForkResult } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * The fork RPC returns before the new thread's shell reaches this client over
 * the shell stream. Navigating to the canonical thread route in that window
 * makes the route resolve to "missing" and bounce to "/", which lands on a
 * fresh empty draft instead of the fork. Wait for the shell (same pattern as
 * waitForStartedServerThread in ChatView.logic.ts); on timeout navigate
 * anyway — the thread exists server-side.
 */
function waitForThreadShell(threadRef: ScopedThreadRef, timeoutMs = 5_000): Promise<boolean> {
  const shellAtom = environmentThreadShells.threadShellAtom(threadRef);
  if (appAtomRegistry.get(shellAtom) !== null) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = appAtomRegistry.subscribe(shellAtom, (shell) => {
      if (shell === null) {
        return;
      }
      finish(true);
    });

    if (appAtomRegistry.get(shellAtom) !== null) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

/**
 * Shared engine behind `useForkThread` (F5) and `useAdoptExternalSession`
 * (F6) — both RPCs return the same `{threadId}` success / `ThreadForkError`
 * failure shape (packages/contracts/src/threadFork.ts) and need the same
 * dispatch -> navigate -> toast choreography (FORK_PLAN_FORKING.md). Both
 * operations are non-destructive (the source thread/session is never
 * touched), so neither gates on a confirmation dialog — the success toast
 * carries the one fact worth knowing instead. A ref-based guard keeps a
 * second call a no-op while one is already in flight.
 */
export function useThreadForkOutcome<W extends { readonly environmentId: EnvironmentId }, E>(
  mutation: AtomCommand<W, ThreadForkResult, E>,
  options: {
    readonly failureTitle: string;
    readonly successToast: { readonly title: string; readonly description: string };
  },
) {
  const runMutation = useAtomCommand(mutation, { reportFailure: false });
  const router = useRouter();
  const pendingRef = useRef(false);

  return useCallback(
    async (target: W) => {
      if (pendingRef.current) return;

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

        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: options.successToast.title,
            description: options.successToast.description,
          }),
        );
        const threadRef = scopeThreadRef(target.environmentId, result.value.threadId);
        await waitForThreadShell(threadRef);
        const navigationResult = await settlePromise(() =>
          router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
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
    [runMutation, router, options.failureTitle, options.successToast],
  );
}
