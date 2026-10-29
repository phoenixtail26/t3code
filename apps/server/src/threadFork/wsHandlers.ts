// Fork feature: WebSocket handler for `threads.adoptExternalSession` (the work
// is in ./ThreadAdoptService.ts). Lives here so ws.ts, which is upstream-owned,
// needs only one import and one spread line. Forking a t3 thread uses upstream's
// native `thread.fork` command from the client, not this file.
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
