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
  type EnvironmentAuthorizationError,
  THREAD_FORK_WS_METHODS,
  type ThreadAdoptExternalSessionInput,
} from "@t3tools/contracts";

import { ThreadAdoptService } from "./ThreadAdoptService.ts";

/** Scope entries to spread into auth/RpcAuthorization.ts's RPC_REQUIRED_SCOPES map. */
export const THREAD_FORK_RPC_SCOPES = {
  [THREAD_FORK_WS_METHODS.adoptExternalSession]: AuthOrchestrationOperateScope,
} as const;

/** Same per-module copy of ws.ts's observe wrapper type as the other fork
 * handler modules (see ../externalSessions/wsHandlers.ts for why). */
export type ObserveRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;

export const makeThreadForkWsHandlers = Effect.fnUntraced(function* (deps: {
  readonly observeRpcEffect: ObserveRpcEffect;
}) {
  const { observeRpcEffect } = deps;
  const adoptService = yield* ThreadAdoptService;

  return {
    [THREAD_FORK_WS_METHODS.adoptExternalSession]: (input: ThreadAdoptExternalSessionInput) =>
      observeRpcEffect(THREAD_FORK_WS_METHODS.adoptExternalSession, adoptService.adopt(input), {
        "rpc.aggregate": "thread-fork",
      }),
  };
});
