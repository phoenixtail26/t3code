// Fork feature: thread forking + external-session adoption
// (FORK_PLAN_FORKING.md). WebSocket RPC handlers for `threads.forkThread`
// and `threads.adoptExternalSession`. Lives here rather than inline in ws.ts
// so the fork's contact surface in that upstream-owned file stays at one
// import and one spread line (same pattern as ../externalSessions/wsHandlers.ts).
//
// Both commands share one shape: resolve a source Claude session → SDK-fork
// its transcript into a fresh session file (the source is never written) →
// dispatch thread.create carrying the seeded cursor → persist the cursor as
// the new thread's provider-session binding → return the new threadId. The
// binding write completes before the RPC returns, and a turn can only be
// requested against a threadId the client knows, so the first turn's
// startSession always sees the seeded cursor (see ./sessionSeed.ts).
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentAuthorizationError,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  THREAD_FORK_WS_METHODS,
  type ThreadAdoptExternalSessionInput,
  ThreadForkError,
  type ThreadForkInput,
  type ThreadForkResult,
  type ThreadInheritedTranscript,
  type ThreadInheritedTranscriptInput,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  buildCwdIndex,
  matchCwdToProject,
  normalizeCwdKey,
} from "../externalSessions/cwdMatching.ts";
import * as ExternalSessionsWatcher from "../externalSessions/ExternalSessionsWatcher.ts";
import { collectOwnSessionIds } from "../externalSessions/ownSessions.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { forkClaudeSession } from "./claudeSessionFork.ts";
import { ADOPT_NOTICE_TEXT, appendForkNotice, FORK_NOTICE_TEXT } from "./forkNotice.ts";
import { loadInheritedEntries } from "./inheritedTranscript.ts";
import { seedThreadSessionBinding } from "./sessionSeed.ts";

/** Scope entries to spread into auth/RpcAuthorization.ts's RPC_REQUIRED_SCOPES map. */
export const THREAD_FORK_RPC_SCOPES = {
  [THREAD_FORK_WS_METHODS.forkThread]: AuthOrchestrationOperateScope,
  [THREAD_FORK_WS_METHODS.adoptExternalSession]: AuthOrchestrationOperateScope,
  [THREAD_FORK_WS_METHODS.getInheritedTranscript]: AuthOrchestrationReadScope,
} as const;

/** Same per-module copy of ws.ts's observe wrapper type as the other fork
 * handler modules (see ../externalSessions/wsHandlers.ts for why). */
export type ObserveRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Extract the resumable Claude session UUID from a persisted cursor
 * (mirrors ClaudeAdapter.readClaudeResumeState's `resume ?? sessionId`). */
function readResumeSessionId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") return undefined;
  const cursor = resumeCursor as { resume?: unknown; sessionId?: unknown };
  const candidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  return candidate && candidate.length > 0 ? candidate : undefined;
}

export const makeThreadForkWsHandlers = Effect.fnUntraced(function* (deps: {
  readonly observeRpcEffect: ObserveRpcEffect;
}) {
  const { observeRpcEffect } = deps;
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const externalSessionsWatcher = yield* ExternalSessionsWatcher.ExternalSessionsWatcher;

  /** Shared tail: create the thread bound to an already-forked session, and
   * remove it again if the cursor cannot be attached. */
  const createSeededThread = Effect.fn("threadFork.createSeededThread")(function* (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly forkedFromThreadId?: ThreadId;
    readonly forkedSessionId: string;
  }) {
    const newThreadId = ThreadId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const commandId = CommandId.make(
      `server:thread-fork:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
    );
    const createdAt = yield* nowIso;
    const seededCursor = {
      threadId: newThreadId,
      resume: input.forkedSessionId,
      turnCount: 0,
    };

    yield* orchestrationEngine
      .dispatch({
        type: "thread.create",
        commandId,
        threadId: newThreadId,
        projectId: input.projectId,
        title: TrimmedNonEmptyString.make(input.title),
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: input.branch,
        worktreePath: input.worktreePath,
        resumeCursor: seededCursor,
        ...(input.forkedFromThreadId !== undefined
          ? { forkedFromThreadId: input.forkedFromThreadId }
          : {}),
        createdAt,
      })
      .pipe(
        Effect.mapError(
          () =>
            new ThreadForkError({
              reason: "create-failed",
              message: "The forked session was created but the new thread could not be.",
            }),
        ),
      );

    yield* seedThreadSessionBinding({
      threadId: newThreadId,
      modelSelection: input.modelSelection,
      resumeCursor: seededCursor,
    }).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          // Without the binding the new thread would silently start a blank
          // session — remove it and surface the failure instead.
          yield* Effect.logWarning("thread fork: cursor seeding failed, deleting new thread", {
            threadId: newThreadId,
            cause,
          });
          yield* orchestrationEngine
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.make(
                `server:thread-fork-cleanup:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
              ),
              threadId: newThreadId,
            })
            .pipe(Effect.catch(() => Effect.void));
          return yield* new ThreadForkError({
            reason: "create-failed",
            message: "Could not attach the forked session to the new thread.",
          });
        }),
      ),
    );

    return { threadId: newThreadId } satisfies ThreadForkResult;
  });

  const forkThread = Effect.fn("threadFork.forkThread")(function* (input: ThreadForkInput) {
    const thread = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getThreadShellById(input.threadId).pipe(
        Effect.mapError(
          () =>
            new ThreadForkError({
              reason: "not-found",
              message: "Failed to load the thread to fork.",
            }),
        ),
      ),
    );
    if (thread === undefined) {
      return yield* new ThreadForkError({
        reason: "not-found",
        message: "Thread to fork was not found.",
      });
    }

    const binding = Option.getOrUndefined(
      yield* providerSessionDirectory
        .getBinding(input.threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );

    // The session that would be forked defines the driver; fall back to the
    // thread's own model selection when no session has ever started.
    const instanceId = binding?.providerInstanceId ?? thread.modelSelection.instanceId;
    const driverKind = binding
      ? binding.provider
      : (yield* providerService.getInstanceInfo(thread.modelSelection.instanceId).pipe(
          Effect.mapError(
            () =>
              new ThreadForkError({
                reason: "unsupported",
                message: "The thread's provider instance is not configured in this build.",
              }),
          ),
        )).driverKind;
    if (driverKind !== "claudeAgent") {
      return yield* new ThreadForkError({
        reason: "unsupported",
        message: "Forking is only supported for Claude threads.",
      });
    }

    const sourceSessionId = readResumeSessionId(binding?.resumeCursor);
    if (sourceSessionId === undefined) {
      return yield* new ThreadForkError({
        reason: "no-session",
        message: "This thread has no Claude session to fork yet. Send a message first.",
      });
    }

    const forked = yield* forkClaudeSession({ sourceSessionId }).pipe(
      Effect.mapError(
        (error) =>
          new ThreadForkError({
            reason: "fork-failed",
            message: `Could not fork the Claude session: ${error.detail}`,
          }),
      ),
    );

    // Best-effort: without the notice the fork still works, it just keeps
    // the source's task momentum (see forkNotice.ts).
    yield* appendForkNotice({
      sessionId: forked.sessionId,
      preferredCwd: thread.worktreePath,
      noticeText: FORK_NOTICE_TEXT,
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("thread fork: notice append failed", { cause }).pipe(Effect.as(false)),
      ),
    );

    // The new thread must start its first turn on the same provider instance
    // the seeded binding names, or startSession ignores the cursor.
    const modelSelection =
      thread.modelSelection.instanceId === instanceId
        ? thread.modelSelection
        : { ...thread.modelSelection, instanceId };

    return yield* createSeededThread({
      projectId: thread.projectId,
      title: `Fork of ${thread.title}`,
      modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      // v1 shares the parent's working tree (FORK_PLAN_FORKING.md #4);
      // pre-fork revert/turn-diff stay with the parent.
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      forkedFromThreadId: input.threadId,
      forkedSessionId: forked.sessionId,
    });
  });

  const adoptExternalSession = Effect.fn("threadFork.adoptExternalSession")(function* (
    input: ThreadAdoptExternalSessionInput,
  ) {
    const sessions = yield* externalSessionsWatcher.snapshot;
    const session = sessions.find((candidate) => candidate.sessionId === input.sessionId);
    if (session === undefined) {
      return yield* new ThreadForkError({
        reason: "not-found",
        message: "Session is not in the radar (unknown, aged out, or filtered).",
      });
    }

    const ownIds = yield* collectOwnSessionIds();
    if (ownIds.has(session.sessionId)) {
      return yield* new ThreadForkError({
        reason: "unsupported",
        message: "This session already belongs to a t3 thread — fork that thread instead.",
      });
    }

    const info = yield* providerService.getInstanceInfo(input.modelSelection.instanceId).pipe(
      Effect.mapError(
        () =>
          new ThreadForkError({
            reason: "unsupported",
            message: "The requested provider instance is not configured in this build.",
          }),
      ),
    );
    if (info.driverKind !== "claudeAgent") {
      return yield* new ThreadForkError({
        reason: "unsupported",
        message: "Adopted sessions can only continue on a Claude provider instance.",
      });
    }

    // Same project matching as the radar sidebar (projects first, so a
    // worktree equal to a workspace root resolves to the project mapping).
    const caseInsensitive = (yield* HostProcessPlatform) === "win32";
    const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
      Effect.mapError(
        () =>
          new ThreadForkError({
            reason: "no-project",
            message: "Failed to load projects to match the session's directory against.",
          }),
      ),
    );
    const index = buildCwdIndex(
      [
        ...shellSnapshot.projects.map((project) => ({
          path: project.workspaceRoot,
          projectId: project.id,
        })),
        ...shellSnapshot.threads.flatMap((thread) =>
          thread.worktreePath === null
            ? []
            : [{ path: thread.worktreePath, projectId: thread.projectId }],
        ),
      ],
      caseInsensitive,
    );
    const matchedProjectId = matchCwdToProject(index, session.cwd, caseInsensitive);
    const project = shellSnapshot.projects.find((candidate) => candidate.id === matchedProjectId);
    if (matchedProjectId === undefined || project === undefined) {
      return yield* new ThreadForkError({
        reason: "no-project",
        message: "The session's working directory doesn't match any t3 project.",
      });
    }

    // Fork, never extend: the CLI keeps sole ownership of its own file.
    const forked = yield* forkClaudeSession({ sourceSessionId: session.sessionId }).pipe(
      Effect.mapError(
        (error) =>
          new ThreadForkError({
            reason: "fork-failed",
            message: `Could not fork the Claude session: ${error.detail}`,
          }),
      ),
    );

    // Best-effort, same as the fork path (see forkNotice.ts).
    yield* appendForkNotice({
      sessionId: forked.sessionId,
      preferredCwd: session.cwd,
      noticeText: ADOPT_NOTICE_TEXT,
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("thread adopt: notice append failed", { cause }).pipe(Effect.as(false)),
      ),
    );

    // Keep the adopted thread working where the session was working: cwd
    // equal to the project root needs no worktree; anything else (an
    // existing thread's worktree) is recorded as a shared worktree path.
    const cwd = session.cwd;
    const worktreePath =
      cwd !== null &&
      normalizeCwdKey(cwd, caseInsensitive) !==
        normalizeCwdKey(project.workspaceRoot, caseInsensitive)
        ? cwd
        : null;

    const title = session.title?.trim();
    return yield* createSeededThread({
      projectId: project.id,
      title: title !== undefined && title.length > 0 ? title : "Adopted Claude session",
      modelSelection: input.modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath,
      forkedSessionId: forked.sessionId,
    });
  });

  // Best-effort by design: every soft failure (no binding, non-Claude
  // driver, missing file, unalignable transcript) answers with an empty
  // slice so the client simply renders no prelude.
  const getInheritedTranscript = Effect.fn("threadFork.getInheritedTranscript")(function* (
    input: ThreadInheritedTranscriptInput,
  ) {
    const empty = {
      threadId: input.threadId,
      entries: [],
      truncated: false,
    } satisfies ThreadInheritedTranscript;

    const binding = Option.getOrUndefined(
      yield* providerSessionDirectory
        .getBinding(input.threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );
    if (binding === undefined || binding.provider !== "claudeAgent") return empty;
    // Ordinary threads short-circuit on the seed-time provenance marker —
    // no detail hydration, no filesystem touch (see sessionSeed.ts).
    const runtimePayload = binding.runtimePayload;
    if (
      runtimePayload === null ||
      runtimePayload === undefined ||
      typeof runtimePayload !== "object" ||
      !("threadFork" in runtimePayload)
    ) {
      return empty;
    }
    const sessionId = readResumeSessionId(binding.resumeCursor);
    if (sessionId === undefined) return empty;

    const detail = Option.getOrUndefined(
      yield* projectionSnapshotQuery
        .getThreadDetailById(input.threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );
    if (detail === undefined) return empty;
    const firstOwn = detail.messages.find((message) => message.role === "user");
    const project = Option.getOrUndefined(
      yield* projectionSnapshotQuery
        .getProjectShellById(detail.projectId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );

    const { entries, truncated } = yield* loadInheritedEntries({
      threadId: input.threadId,
      sessionId,
      preferredCwd: detail.worktreePath ?? project?.workspaceRoot ?? null,
      firstOwnMessage: firstOwn ? { text: firstOwn.text, createdAt: firstOwn.createdAt } : null,
    });
    return { threadId: input.threadId, entries, truncated } satisfies ThreadInheritedTranscript;
  });

  return {
    [THREAD_FORK_WS_METHODS.forkThread]: (input: ThreadForkInput) =>
      observeRpcEffect(THREAD_FORK_WS_METHODS.forkThread, forkThread(input), {
        "rpc.aggregate": "thread-fork",
      }),
    [THREAD_FORK_WS_METHODS.adoptExternalSession]: (input: ThreadAdoptExternalSessionInput) =>
      observeRpcEffect(THREAD_FORK_WS_METHODS.adoptExternalSession, adoptExternalSession(input), {
        "rpc.aggregate": "thread-fork",
      }),
    [THREAD_FORK_WS_METHODS.getInheritedTranscript]: (input: ThreadInheritedTranscriptInput) =>
      observeRpcEffect(
        THREAD_FORK_WS_METHODS.getInheritedTranscript,
        getInheritedTranscript(input),
        { "rpc.aggregate": "thread-fork" },
      ),
  };
});
