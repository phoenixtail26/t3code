// Fork feature: external-session adoption (FORK_PLAN_FORKING.md). Binds a new t3
// thread to a radar-found Claude CLI session through a strong `nativeThreadRef`
// (upstream's AgentSessionImporter recipe) and imports the visible transcript as
// history. A service because it needs the v2 event sink and id allocator.
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  type ThreadAdoptExternalSessionInput,
  ThreadForkError,
  type ThreadForkResult,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  buildCwdIndex,
  matchCwdToProject,
  normalizeCwdKey,
} from "../externalSessions/cwdMatching.ts";
import * as ExternalSessionsWatcher from "../externalSessions/ExternalSessionsWatcher.ts";
import { collectOwnSessionIds } from "../externalSessions/ownSessions.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  type AgentSessionThreadMessage,
  parseAgentSessionTranscript,
} from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

export class ThreadAdoptService extends Context.Service<
  ThreadAdoptService,
  {
    readonly adopt: (
      input: ThreadAdoptExternalSessionInput,
    ) => Effect.Effect<ThreadForkResult, ThreadForkError>;
  }
>()("t3/threadFork/ThreadAdoptService") {}

const ADOPT_EVENT_PREFIX = "fork-adopt:v2";
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

/** Mirrors AgentSessionImporter's messageEvents: one message plus one completed turn item. */
function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(`${ADOPT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`);
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${ADOPT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${ADOPT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagement.ThreadManagementService;
  const projectService = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const externalSessionsWatcher = yield* ExternalSessionsWatcher.ExternalSessionsWatcher;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const sql = yield* SqlClient.SqlClient;

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

    const ownIds = yield* collectOwnSessionIds().pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    if (ownIds.has(session.sessionId)) {
      return yield* new ThreadForkError({
        reason: "unsupported",
        message: "This session already belongs to a t3 thread. Fork that thread instead.",
      });
    }

    const instance = yield* instanceRegistry.getInstance(input.modelSelection.instanceId);
    if (instance === undefined || instance.driverKind !== CLAUDE_DRIVER) {
      return yield* new ThreadForkError({
        reason: "unsupported",
        message: "Adopted sessions can only continue on a Claude provider instance.",
      });
    }

    const caseInsensitive = platform === "win32";
    const shell = yield* Effect.all({
      projects: projectService.listShells(),
      threads: threadManagement.getShellSnapshot().pipe(Effect.map((snapshot) => snapshot.threads)),
    }).pipe(
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
        ...shell.projects.map((project) => ({
          path: project.workspaceRoot,
          projectId: project.id,
        })),
        ...shell.threads.flatMap((thread) =>
          thread.worktreePath === null
            ? []
            : [{ path: thread.worktreePath, projectId: thread.projectId }],
        ),
      ],
      caseInsensitive,
    );
    const matchedProjectId = matchCwdToProject(index, session.cwd, caseInsensitive);
    const project = shell.projects.find((candidate) => candidate.id === matchedProjectId);
    if (matchedProjectId === undefined || project === undefined) {
      return yield* new ThreadForkError({
        reason: "no-project",
        message: "The session's working directory doesn't match any t3 project.",
      });
    }

    // Upstream's transcript parser keeps visible user/assistant text and drops
    // tool calls, reasoning and malformed records. Over the record cap it
    // returns null: adopt the session anyway, just without imported history.
    const contents = yield* fs.readFileString(session.filePath).pipe(
      Effect.mapError(
        () =>
          new ThreadForkError({
            reason: "fork-failed",
            message: "Failed to read the session transcript; it may have been deleted.",
          }),
      ),
    );
    const lastActiveAtMs = yield* fs.stat(session.filePath).pipe(
      Effect.map((info) => Option.map(info.mtime, (mtime) => mtime.getTime())),
      Effect.orElseSucceed(() => Option.none<number>()),
      Effect.map(Option.getOrElse(() => Date.parse(session.lastActivityAt))),
    );
    const parsed = parseAgentSessionTranscript({
      source: "claudeAgent",
      providerInstanceId: input.modelSelection.instanceId,
      fallbackSessionId: session.sessionId,
      lastActiveAtMs,
      contents,
    });

    const cwd = session.cwd;
    const worktreePath =
      cwd !== null &&
      normalizeCwdKey(cwd, caseInsensitive) !==
        normalizeCwdKey(project.workspaceRoot, caseInsensitive)
        ? cwd
        : null;
    const title = (session.title ?? parsed?.title)?.trim();
    const now = yield* DateTime.now;
    const createdAt = parsed ? dateTime(parsed.createdAt) : now;
    const updatedAt = parsed ? dateTime(parsed.updatedAt) : now;

    const threadId = ThreadId.make(`adopt:${input.modelSelection.instanceId}:${session.sessionId}`);
    const existing = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (existing !== null) {
      // Idempotent: a second adopt of the same session opens the same thread.
      return { threadId } satisfies ThreadForkResult;
    }
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CLAUDE_DRIVER,
      nativeThreadId: session.sessionId,
    });
    const appThread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "server",
      id: threadId,
      projectId: project.id,
      title: title !== undefined && title.length > 0 ? title : "Adopted Claude session",
      providerInstanceId: input.modelSelection.instanceId,
      modelSelection: input.modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: providerThreadId,
      historyOrigin: "native",
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt,
      updatedAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver: CLAUDE_DRIVER,
      providerInstanceId: input.modelSelection.instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: {
        driver: CLAUDE_DRIVER,
        nativeId: session.sessionId,
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt,
      updatedAt,
    };

    yield* eventSink
      .write({
        events: [
          {
            id: EventId.make(`${ADOPT_EVENT_PREFIX}:thread:${threadId}:created`),
            type: "thread.created",
            threadId,
            providerInstanceId: input.modelSelection.instanceId,
            occurredAt: createdAt,
            payload: appThread,
          },
          ...(parsed?.messages ?? []).flatMap((message, index) =>
            messageEvents({ threadId, index, message }),
          ),
          {
            id: EventId.make(`${ADOPT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
            type: "provider-thread.updated",
            threadId,
            driver: CLAUDE_DRIVER,
            providerInstanceId: input.modelSelection.instanceId,
            occurredAt: updatedAt,
            payload: providerThread,
          },
        ],
      })
      .pipe(
        Effect.mapError(
          () =>
            new ThreadForkError({
              reason: "create-failed",
              message: "Could not create the thread for the adopted session.",
            }),
        ),
      );

    return { threadId } satisfies ThreadForkResult;
  });

  return ThreadAdoptService.of({ adopt: adoptExternalSession });
});

export const layer = Layer.effect(ThreadAdoptService, make);
