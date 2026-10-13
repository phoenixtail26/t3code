// Fork feature: external-session adoption (FORK_PLAN_FORKING.md). WebSocket
// RPC handler for `threads.adoptExternalSession`. Lives here rather than
// inline in ws.ts so the fork's contact surface in that upstream-owned file
// stays at one import and one spread line (same pattern as
// ../externalSessions/wsHandlers.ts). The work is in ./ThreadAdoptService.ts.
//
// Forking a t3 thread no longer goes through here: the sidebar's "Fork thread"
// dispatches upstream's native `thread.fork` command from the client
// (apps/web/src/threadFork/useForkThread.ts).
import * as Effect from "effect/Effect";

import {
  AuthOrchestrationOperateScope,
  THREAD_FORK_WS_METHODS,
  type ThreadAdoptExternalSessionInput,
} from "@t3tools/contracts";

import { ThreadAdoptService } from "./ThreadAdoptService.ts";

/** Scope entries to spread into auth/RpcAuthorization.ts's RPC_REQUIRED_SCOPES map. */
export const THREAD_FORK_RPC_SCOPES = {
  [THREAD_FORK_WS_METHODS.adoptExternalSession]: AuthOrchestrationOperateScope,
} as const;

/** Aggregate labels to spread into observability/RpcInstrumentation.ts's RPC_AGGREGATES map. */
export const THREAD_FORK_RPC_AGGREGATES = {
  [THREAD_FORK_WS_METHODS.adoptExternalSession]: "thread-fork",
} as const;

export const makeThreadForkWsHandlers = Effect.fnUntraced(function* () {
  const adoptService = yield* ThreadAdoptService;

  return {
    [THREAD_FORK_WS_METHODS.adoptExternalSession]: (input: ThreadAdoptExternalSessionInput) =>
      adoptService.adopt(input),
  };
});
