// Fork feature ("the radar"): WebSocket RPC handler for external Claude Code
// session subscriptions. Lives here rather than inline in ws.ts so the fork's
// contact surface in that upstream-owned file stays at one import and two
// spread lines (see AGENTS.md, "Fork additions").
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  AuthOrchestrationReadScope,
  EXTERNAL_SESSIONS_WS_METHODS,
  type EnvironmentAuthorizationError,
  type ExternalSessionShell,
  ExternalSessionTranscriptError,
  type ExternalSessionTranscript,
  type ExternalSessionsStreamItem,
  type OrchestrationShellSnapshot,
  ProjectId,
} from "@t3tools/contracts";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { buildCwdIndex, matchCwdToProject } from "./cwdMatching.ts";
import * as ExternalSessionsWatcher from "./ExternalSessionsWatcher.ts";
import { collectOwnSessionIds } from "./ownSessions.ts";
import { mapTranscriptContent, MAX_TRANSCRIPT_READ_BYTES } from "./transcriptView.ts";

/** Scope entries to spread into auth/RpcAuthorization.ts's RPC_REQUIRED_SCOPES map. */
export const EXTERNAL_SESSIONS_RPC_SCOPES = {
  [EXTERNAL_SESSIONS_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [EXTERNAL_SESSIONS_WS_METHODS.getTranscript]: AuthOrchestrationReadScope,
} as const;

/**
 * ws.ts's per-connection instrumentation + authorization wrapper for
 * stream-returning RPCs. Mirrors the signature composed there from
 * RpcInstrumentation.observeRpcStreamEffect and authorizeEffect.
 */
export type ObserveRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
  method: string,
  effect: Effect.Effect<Stream.Stream<A, StreamError, StreamContext>, EffectError, EffectContext>,
  traceAttributes?: Readonly<Record<string, unknown>>,
) => Stream.Stream<
  A,
  StreamError | EffectError | EnvironmentAuthorizationError,
  StreamContext | EffectContext
>;

/**
 * ws.ts's per-connection instrumentation + authorization wrapper for
 * effect-returning RPCs. Mirrors the signature composed there from
 * RpcInstrumentation.observeRpcEffect and authorizeEffect. Duplicated here
 * rather than imported from `../notifications/wsHandlers.ts` — each RPC
 * handler module declares its own copy of this type (see that file).
 */
export type ObserveRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;

const textDecoder = new TextDecoder();

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Builds the external-sessions RPC handler entries for WsRpcGroup.of(...).
 * Yields its own service dependencies so the caller only supplies the
 * connection-scoped observe wrapper.
 */
export const makeExternalSessionsWsHandlers = Effect.fnUntraced(function* (deps: {
  readonly observeRpcStreamEffect: ObserveRpcStreamEffect;
  readonly observeRpcEffect: ObserveRpcEffect;
}) {
  const { observeRpcStreamEffect, observeRpcEffect } = deps;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const externalSessionsWatcher = yield* ExternalSessionsWatcher.ExternalSessionsWatcher;
  const fs = yield* FileSystem.FileSystem;

  // Mirrors ExternalSessionsWatcher's readRange (same open/seek/readAlloc
  // approach) — replicated locally rather than imported so this module
  // stays free of a dependency on the watcher's internals.
  const readRange = Effect.fn("externalSessions.wsHandlers.readRange")(function* (
    filePath: string,
    start: number,
    end: number,
  ) {
    if (end <= start) return new Uint8Array(0);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(filePath);
        if (start > 0) yield* file.seek(start, "start");
        const read = yield* file.readAlloc(end - start);
        return Option.getOrElse(read, () => new Uint8Array(0));
      }),
    );
  });

  // Reads a session transcript file, capping at MAX_TRANSCRIPT_READ_BYTES:
  // large files are tailed (dropping the leading partial line) rather than
  // read in full, mirroring the watcher's tail-read caps.
  const readTranscriptFile = Effect.fn("externalSessions.wsHandlers.readTranscriptFile")(function* (
    filePath: string,
  ) {
    const info = yield* fs.stat(filePath);
    const size = Number(info.size);
    if (size <= MAX_TRANSCRIPT_READ_BYTES) {
      const text = yield* fs.readFileString(filePath);
      return { text, byteCapTripped: false };
    }
    const start = size - MAX_TRANSCRIPT_READ_BYTES;
    const bytes = yield* readRange(filePath, start, size);
    const raw = textDecoder.decode(bytes);
    const firstNewline = raw.indexOf("\n");
    const text = firstNewline === -1 ? "" : raw.slice(firstNewline + 1);
    return { text, byteCapTripped: true };
  });

  return {
    [EXTERNAL_SESSIONS_WS_METHODS.subscribe]: (_input: unknown) =>
      observeRpcStreamEffect(
        EXTERNAL_SESSIONS_WS_METHODS.subscribe,
        Effect.gen(function* () {
          // Windows filesystems are case-insensitive; cwd matching must
          // normalize accordingly (cwdMatching.ts).
          const caseInsensitive = (yield* HostProcessPlatform) === "win32";

          // A snapshot load failure must not fail the subscription: the
          // radar is best-effort, so degrade to an empty snapshot (no
          // roots watched, no matches) rather than surfacing an error.
          const shellSnapshot: OrchestrationShellSnapshot = yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning(
                  "external sessions: shell snapshot load failed, serving empty snapshot",
                  { cause },
                ).pipe(
                  Effect.flatMap(() => nowIso),
                  Effect.map(
                    (updatedAt): OrchestrationShellSnapshot => ({
                      snapshotSequence: 0,
                      projects: [],
                      threads: [],
                      updatedAt,
                    }),
                  ),
                ),
              ),
            );

          // Projects first: buildCwdIndex keeps the first entry for a
          // given path, so a worktree that equals a workspace root
          // resolves to the project mapping (cwdMatching.ts).
          const projectEntries = shellSnapshot.projects.map((project) => ({
            path: project.workspaceRoot,
            projectId: project.id,
          }));
          const threadEntries = shellSnapshot.threads.flatMap((thread) =>
            thread.worktreePath === null
              ? []
              : [{ path: thread.worktreePath, projectId: thread.projectId }],
          );
          yield* externalSessionsWatcher.ensureRoots(
            [...projectEntries, ...threadEntries].map((entry) => entry.path),
          );
          const index = buildCwdIndex([...projectEntries, ...threadEntries], caseInsensitive);

          const toShell = (
            session: ExternalSessionsWatcher.ExternalSessionSnapshot,
            ownIds: ReadonlySet<string>,
          ): ExternalSessionShell | null => {
            if (ownIds.has(session.sessionId)) return null;
            const projectId = matchCwdToProject(index, session.cwd, caseInsensitive);
            if (projectId === undefined) return null;
            return {
              sessionId: session.sessionId,
              projectId: ProjectId.make(projectId),
              title: session.title,
              state: session.state,
              lastActivityAt: session.lastActivityAt,
              cwd: session.cwd,
            };
          };

          // Per-subscription state: which sessionIds have already been
          // sent to this client, so a session that stops matching (own
          // session created mid-connection, or falls off cwd match) is
          // reported as removed instead of silently dropped.
          const sent = new Set<string>();

          const toLiveStreamItem = (event: ExternalSessionsWatcher.ExternalSessionsEvent) => {
            if (event.kind === "removed") {
              if (!sent.has(event.sessionId)) {
                return Effect.succeed(Option.none<ExternalSessionsStreamItem>());
              }
              sent.delete(event.sessionId);
              return Effect.succeed(
                Option.some<ExternalSessionsStreamItem>({
                  kind: "removed",
                  sessionId: event.sessionId,
                }),
              );
            }
            // Recomputed per event (cheap: small SQL table + in-memory
            // list) so a thread created mid-connection is not reported as
            // an external session.
            return collectOwnSessionIds().pipe(
              Effect.map((ownIds) => {
                const shell = toShell(event.session, ownIds);
                if (shell !== null) {
                  sent.add(shell.sessionId);
                  return Option.some<ExternalSessionsStreamItem>({
                    kind: "upserted",
                    session: shell,
                  });
                }
                if (sent.has(event.session.sessionId)) {
                  sent.delete(event.session.sessionId);
                  return Option.some<ExternalSessionsStreamItem>({
                    kind: "removed",
                    sessionId: event.session.sessionId,
                  });
                }
                return Option.none();
              }),
            );
          };

          const liveStream = externalSessionsWatcher.changes.pipe(
            Stream.mapEffect(toLiveStreamItem),
            Stream.flatMap((item) =>
              Option.isSome(item) ? Stream.succeed(item.value) : Stream.empty,
            ),
          );

          // Attach the live subscription before reading the current
          // snapshot so nothing published while the snapshot loads is
          // lost (mirrors subscribeShell's live-before-catchup ordering).
          const liveBuffer = yield* Queue.unbounded<ExternalSessionsStreamItem>();
          yield* Effect.forkScoped(
            liveStream.pipe(Stream.runForEach((item) => Queue.offer(liveBuffer, item))),
          );

          const initialOwnIds = yield* collectOwnSessionIds();
          const initialSnapshot = yield* externalSessionsWatcher.snapshot;
          const sessions = initialSnapshot
            .map((session) => toShell(session, initialOwnIds))
            .filter((shell): shell is ExternalSessionShell => shell !== null);
          for (const shell of sessions) sent.add(shell.sessionId);

          return Stream.concat(
            Stream.make({ kind: "snapshot" as const, sessions }),
            Stream.fromQueue(liveBuffer),
          );
        }),
        { "rpc.aggregate": "external-sessions" },
      ),
    [EXTERNAL_SESSIONS_WS_METHODS.getTranscript]: (input: { readonly sessionId: string }) =>
      observeRpcEffect(
        EXTERNAL_SESSIONS_WS_METHODS.getTranscript,
        Effect.gen(function* () {
          const sessions = yield* externalSessionsWatcher.snapshot;
          const session = sessions.find((candidate) => candidate.sessionId === input.sessionId);
          if (session === undefined) {
            return yield* new ExternalSessionTranscriptError({
              reason: "not-found",
              message: "Session is not in the radar (unknown, aged out, or filtered).",
            });
          }

          const { text, byteCapTripped } = yield* readTranscriptFile(session.filePath).pipe(
            Effect.mapError(
              () =>
                new ExternalSessionTranscriptError({
                  reason: "read-failed",
                  message: "Failed to read the session transcript; it may have been deleted.",
                }),
            ),
          );
          const { entries, entryCapTripped } = mapTranscriptContent(text);

          return {
            sessionId: session.sessionId,
            title: session.title,
            state: session.state,
            lastActivityAt: session.lastActivityAt,
            cwd: session.cwd,
            entries,
            truncated: byteCapTripped || entryCapTripped,
          } satisfies ExternalSessionTranscript;
        }),
        { "rpc.aggregate": "external-sessions" },
      ),
  };
});
