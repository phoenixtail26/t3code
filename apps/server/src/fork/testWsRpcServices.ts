import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ExternalSessionsWatcher from "../externalSessions/ExternalSessionsWatcher.ts";
import * as WebPushStore from "../notifications/WebPushStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ThreadAdoptService from "../threadFork/ThreadAdoptService.ts";

// Unused stand-ins for the services the fork's ws.ts handlers need. Tests that
// build the production RPC layer (see `layerUnusedConfigRpcServices` in
// ws.test.ts) merge this in, so fork handlers fail only if a test calls them.
export const layerUnusedForkWsRpcServices = Layer.mergeAll(
  Layer.mock(ExternalSessionsWatcher.ExternalSessionsWatcher)({}),
  Layer.mock(WebPushStore.WebPushStore)({}),
  Layer.mock(ThreadAdoptService.ThreadAdoptService)({}),
);

// Same idea for serverRuntimeStartup.test.ts: the fork's startup additions
// (radar watcher start, repository-root bootstrap) run against inert stand-ins.
export const layerUnusedForkStartupServices = Layer.mergeAll(
  Layer.mock(ExternalSessionsWatcher.ExternalSessionsWatcher)({ start: Effect.void }),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
    resolveWorkspaceRoot: (cwd) => Effect.succeed(cwd),
  }),
);
