import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { THREAD_FORK_WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * External-session adoption (FORK_PLAN_FORKING.md). Mirrors the
 * `state/git.ts` / `state/threads.ts` atom-composition pattern for the
 * fork-owned RPC, kept out of `state/threads.ts` (upstream-owned) so the
 * fork's plumbing has no upstream merge-conflict surface. Forking a thread
 * uses upstream's own `threadEnvironment.forkFromRun` (useForkThread.ts).
 */
export const threadForkEnvironment = {
  adopt: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:commands:thread:adopt-external-session",
    tag: THREAD_FORK_WS_METHODS.adoptExternalSession,
  }),
};
