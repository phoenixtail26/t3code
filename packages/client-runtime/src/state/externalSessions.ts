import {
  EXTERNAL_SESSIONS_WS_METHODS,
  type EnvironmentId,
  type ExternalSessionShell,
  type ExternalSessionsStreamItem,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { subscribe } from "../rpc/client.ts";
import { arrayElementsEqual } from "./entities.ts";
import { createEnvironmentRpcQueryAtomFamily, followStreamInEnvironment } from "./runtime.ts";

/**
 * External Claude Code sessions ("the radar") — fork feature. See
 * `packages/contracts/src/externalSessions.ts` and
 * `apps/server/src/externalSessions/DESIGN.md`.
 */

export type EnvironmentExternalSessionsState = ReadonlyMap<string, ExternalSessionShell>;

const EMPTY_EXTERNAL_SESSIONS_STATE: EnvironmentExternalSessionsState = new Map();
const EMPTY_EXTERNAL_SESSIONS: ReadonlyArray<ExternalSessionShell> = Object.freeze([]);

function applyExternalSessionsItem(
  current: EnvironmentExternalSessionsState,
  item: ExternalSessionsStreamItem,
): EnvironmentExternalSessionsState {
  switch (item.kind) {
    case "snapshot": {
      // A snapshot is always the first item of a (re)subscription, so this
      // wholesale replacement guarantees stale rows from a previous
      // connection can never linger.
      const next = new Map<string, ExternalSessionShell>();
      for (const session of item.sessions) {
        next.set(session.sessionId, session);
      }
      return next;
    }
    case "upserted": {
      const next = new Map(current);
      next.set(item.session.sessionId, item.session);
      return next;
    }
    case "removed": {
      if (!current.has(item.sessionId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(item.sessionId);
      return next;
    }
  }
}

/**
 * Per-environment external-sessions state: a live map of Claude Code sessions
 * driven outside t3code, keyed by session id. Follows `makeEnvironmentShellState`
 * but has no snapshot cache: the stream is unsequenced, so the server's first
 * `snapshot` item is the only base state.
 */
const makeEnvironmentExternalSessionsState = Effect.fn("EnvironmentExternalSessionsState.make")(
  function* () {
    const state = yield* SubscriptionRef.make<EnvironmentExternalSessionsState>(
      EMPTY_EXTERNAL_SESSIONS_STATE,
    );

    const applyItem = (item: ExternalSessionsStreamItem) =>
      SubscriptionRef.update(state, (current) => applyExternalSessionsItem(current, item));

    yield* Effect.forkScoped(
      subscribe(
        EXTERNAL_SESSIONS_WS_METHODS.subscribe,
        {},
        {
          onExpectedFailure: (cause) =>
            Effect.logWarning("Could not synchronize external sessions.").pipe(
              Effect.annotateLogs({ ...safeErrorLogAttributes(Cause.squash(cause)) }),
            ),
        },
      ).pipe(Stream.runForEach(applyItem)),
    );

    return state;
  },
);

function externalSessionsStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentExternalSessionsState().pipe(Effect.map(SubscriptionRef.changes))),
  );
}

function sortExternalSessions(
  sessions: ReadonlyArray<ExternalSessionShell>,
): ReadonlyArray<ExternalSessionShell> {
  return [...sessions].sort((left, right) => {
    if (left.state !== right.state) {
      return left.state === "working" ? -1 : 1;
    }
    return right.lastActivityAt.localeCompare(left.lastActivityAt);
  });
}

export function createEnvironmentExternalSessionsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(externalSessionsStateChanges(environmentId), {
      initialValue: EMPTY_EXTERNAL_SESSIONS_STATE,
    }),
  );

  const stateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(
        AsyncResult.value(get(stateAtom(environmentId))),
        () => EMPTY_EXTERNAL_SESSIONS_STATE,
      ),
    ).pipe(Atom.withLabel(`environment-external-sessions-value:${environmentId}`)),
  );

  // Keyed like projectKey/threadKey in entities.ts: a NUL-separated
  // environmentId + projectId pair.
  const sessionsForProjectAtomFamily = Atom.family((key: string) => {
    const separator = key.indexOf("\u0000");
    const environmentId = key.slice(0, separator) as EnvironmentId;
    const projectId = key.slice(separator + 1);
    let previous: ReadonlyArray<ExternalSessionShell> = EMPTY_EXTERNAL_SESSIONS;
    return Atom.make((get) => {
      const sessions = get(stateValueAtom(environmentId));
      const next: Array<ExternalSessionShell> = [];
      for (const session of sessions.values()) {
        if (session.projectId === projectId) {
          next.push(session);
        }
      }
      const sorted = sortExternalSessions(next);
      if (arrayElementsEqual(previous, sorted)) {
        return previous;
      }
      previous = sorted;
      return previous;
    }).pipe(Atom.withLabel(`environment-external-sessions-for-project:${key}`));
  });

  // Sessions are already keyed by sessionId in `stateValueAtom` (one map per
  // environment), so finding a single session by id is a lookup, not a new
  // subscription -- sessionId is unique per environment, no per-project
  // scoping needed.
  const sessionByIdAtomFamily = Atom.family((key: string) => {
    const separator = key.indexOf(`\u0000`);
    const environmentId = key.slice(0, separator) as EnvironmentId;
    const sessionId = key.slice(separator + 1);
    return Atom.make((get) => get(stateValueAtom(environmentId)).get(sessionId) ?? null).pipe(
      Atom.withLabel(`environment-external-session-by-id:${key}`),
    );
  });

  return {
    stateAtom,
    stateValueAtom,
    sessionsForProjectAtom: (
      environmentId: EnvironmentId,
      projectId: string,
    ): Atom.Atom<ReadonlyArray<ExternalSessionShell>> =>
      sessionsForProjectAtomFamily(`${environmentId}\u0000${projectId}`),
    sessionByIdAtom: (
      environmentId: EnvironmentId,
      sessionId: string,
    ): Atom.Atom<ExternalSessionShell | null> =>
      sessionByIdAtomFamily(`${environmentId}\u0000${sessionId}`),
    /**
     * Read-only transcript view (Phase 4/5). SWR query keyed by
     * `{environmentId, input: {sessionId}}` -- see
     * `createEnvironmentRpcQueryAtomFamily`. Callers force a refetch (e.g. on
     * `lastActivityAt` changes) via `useAtomRefresh` on the returned atom.
     */
    transcript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:external-sessions:transcript",
      tag: EXTERNAL_SESSIONS_WS_METHODS.getTranscript,
    }),
  };
}
