import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { THREAD_FORK_WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * External-session adoption RPC, kept out of upstream-owned `state/threads.ts`.
 * Forking a thread uses upstream's `threadEnvironment.forkFromRun` instead.
 */
export const threadForkEnvironment = {
  adopt: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:commands:thread:adopt-external-session",
    tag: THREAD_FORK_WS_METHODS.adoptExternalSession,
  }),
};
