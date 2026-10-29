import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadForkResult } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useRef } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * The fork RPC returns before the new thread's shell reaches this client.
 * Navigating in that window bounces to "/" and a fresh empty draft, so wait for
 * the shell (like waitForStartedServerThread in ChatView.logic.ts). On timeout
 * navigate anyway: the thread exists server-side.
 */
export function waitForThreadShell(
  threadRef: ScopedThreadRef,
  timeoutMs = 5_000,
): Promise<boolean> {
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
 * Dispatch, navigate, toast behind `useAdoptExternalSession`. Adoption is
 * non-destructive, so there is no confirmation dialog. A ref guard makes a
 * second call a no-op while one is in flight.
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

  return async (target: W) => {
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
  };
}
