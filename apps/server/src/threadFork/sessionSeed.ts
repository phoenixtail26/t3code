// Fork feature: thread forking / external-session adoption (FORK_PLAN_FORKING.md).
//
// Seeds a brand-new thread's provider-session binding with a resume cursor so
// the thread's first turn resumes an existing CLI session (a forked copy of a
// parent thread's session, or an adopted external one) through the untouched
// lazy-start path: ProviderService.startSession reads the persisted binding's
// resumeCursor when the caller passes none and the instance ids match.
//
// Ordering guarantee: the fork RPC (wsHandlers.ts here) awaits this write
// before returning the new threadId to the client, and a turn can only be
// requested against a threadId the client knows — so the binding always lands
// before the first startSession read. No reactor is involved on purpose: a
// separate reactor subscription would race ProviderCommandReactor's own
// worker, and piggybacking inside ProviderCommandReactor would grow the
// fork's footprint in an upstream conflict hotspot.
import type { ModelSelection, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";

/**
 * Persist `resumeCursor` as `threadId`'s provider-session binding. The thread
 * has no live session yet, so the row is written with status "stopped";
 * ProviderService.startSession ignores binding status and only requires the
 * binding's providerInstanceId to match the instance the turn starts with.
 */
export const seedThreadSessionBinding = Effect.fn("seedThreadSessionBinding")(function* (input: {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly resumeCursor: unknown;
}) {
  const providerService = yield* ProviderService;
  const directory = yield* ProviderSessionDirectory;
  const info = yield* providerService.getInstanceInfo(input.modelSelection.instanceId);
  yield* directory.upsert({
    threadId: input.threadId,
    provider: info.driverKind,
    providerInstanceId: input.modelSelection.instanceId,
    status: "stopped",
    resumeCursor: input.resumeCursor,
  });
});
