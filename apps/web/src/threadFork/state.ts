import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { THREAD_FORK_WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Thread forking (FORK_PLAN_FORKING.md, increment F5). Mirrors the
 * `state/git.ts` / `state/threads.ts` atom-composition pattern for a single
 * fork-owned RPC command, kept out of `state/threads.ts` (upstream-owned) so
 * the fork's plumbing has no upstream merge-conflict surface.
 */
export const threadForkEnvironment = {
  fork: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:commands:thread:fork",
    tag: THREAD_FORK_WS_METHODS.forkThread,
  }),
  adopt: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:commands:thread:adopt-external-session",
    tag: THREAD_FORK_WS_METHODS.adoptExternalSession,
  }),
};
