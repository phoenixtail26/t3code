// @effect-diagnostics nodeBuiltinImport:off
// Command-flow test for threads.forkThread: mocked projection/engine/provider
// services, a real ProviderSessionDirectory over in-memory sqlite, and the
// real SDK forkSession working on a temp CLAUDE_CONFIG_DIR seeded with a
// fixture session (raw node:fs is deliberate — the SDK works on the real
// filesystem).
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type OrchestrationCommand,
  OrchestrationThreadShell,
  ProviderDriverKind,
  ProviderInstanceId,
  THREAD_FORK_WS_METHODS,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ExternalSessionsWatcher from "../externalSessions/ExternalSessionsWatcher.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderValidationError } from "../provider/Errors.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { makeThreadForkWsHandlers } from "./wsHandlers.ts";

const decodeThreadShell = Schema.decodeUnknownSync(OrchestrationThreadShell);

const SOURCE_SESSION_ID = "ae214dc4-2886-4e93-9bbf-47abcfde2db7";
const PARENT_THREAD_ID = ThreadId.make("thread-parent");

const FIXTURE = NodePath.join(
  import.meta.dirname,
  "..",
  "externalSessions",
  "__fixtures__",
  "short-session.jsonl",
);

let sharedHome: string | undefined;

/** One temp home per test process — CLAUDE_CONFIG_DIR is read once by the SDK. */
function ensureTempClaudeHome(): void {
  if (sharedHome === undefined) {
    sharedHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-rpc-test-"));
    process.env["CLAUDE_CONFIG_DIR"] = sharedHome;
  }
  const projectDir = NodePath.join(sharedHome, "projects", "C--fake-project");
  NodeFS.mkdirSync(projectDir, { recursive: true });
  const sessionFile = NodePath.join(projectDir, `${SOURCE_SESSION_ID}.jsonl`);
  if (!NodeFS.existsSync(sessionFile)) {
    NodeFS.copyFileSync(FIXTURE, sessionFile);
  }
}

const parentShell = (overrides?: { readonly instanceId?: string }) =>
  decodeThreadShell({
    id: PARENT_THREAD_ID,
    projectId: "project-1",
    title: "Investigate reconnect failures",
    modelSelection: {
      instanceId: overrides?.instanceId ?? "claudeAgent",
      model: "claude-opus-4-6",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const emptyWatcherLayer = Layer.mock(ExternalSessionsWatcher.ExternalSessionsWatcher)({
  snapshot: Effect.succeed([]),
});

const makeHarness = (options?: {
  readonly shell?: ReturnType<typeof parentShell> | undefined;
  readonly driverKind?: string;
}) => {
  const dispatched: Array<OrchestrationCommand> = [];
  const shell = "shell" in (options ?? {}) ? options?.shell : parentShell();
  const driverKind = options?.driverKind ?? "claudeAgent";

  const layer = Layer.mergeAll(
    ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntime.layer),
      Layer.provide(SqlitePersistenceMemory),
    ),
    Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(
          threadId === PARENT_THREAD_ID && shell !== undefined ? Option.some(shell) : Option.none(),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: dispatched.length });
      },
    }),
    Layer.mock(ProviderService)({
      getInstanceInfo: (instanceId) =>
        Effect.succeed({
          instanceId,
          driverKind: ProviderDriverKind.make(driverKind),
          displayName: "Claude Code",
          enabled: true,
          continuationIdentity: {
            driverKind: ProviderDriverKind.make(driverKind),
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
        }),
    }),
    cryptoLayer,
    NodeServices.layer,
    emptyWatcherLayer,
  );

  const observeRpcEffect = (<A, E, R>(_method: string, effect: Effect.Effect<A, E, R>) =>
    effect) as Parameters<typeof makeThreadForkWsHandlers>[0]["observeRpcEffect"];

  return { layer, dispatched, observeRpcEffect };
};

const seedParentBinding = (resumeCursor: unknown) =>
  Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory;
    yield* directory.upsert({
      threadId: PARENT_THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      status: "stopped",
      resumeCursor,
    });
  });

const callForkThread = (harness: ReturnType<typeof makeHarness>) =>
  Effect.gen(function* () {
    const handlers = yield* makeThreadForkWsHandlers({
      observeRpcEffect: harness.observeRpcEffect,
    });
    return yield* handlers[THREAD_FORK_WS_METHODS.forkThread]({ threadId: PARENT_THREAD_ID });
  });

it.effect("forks the session and creates a seeded thread", () =>
  Effect.gen(function* () {
    ensureTempClaudeHome();
    const harness = makeHarness();
    const result = yield* Effect.gen(function* () {
      yield* seedParentBinding({
        threadId: PARENT_THREAD_ID,
        resume: SOURCE_SESSION_ID,
        turnCount: 3,
      });
      return yield* callForkThread(harness);
    }).pipe(Effect.provide(harness.layer));

    assert.notStrictEqual(result.threadId, PARENT_THREAD_ID);

    const create = harness.dispatched.find((command) => command.type === "thread.create");
    assert.ok(create && create.type === "thread.create");
    assert.strictEqual(create.threadId, result.threadId);
    assert.strictEqual(create.projectId, "project-1");
    assert.strictEqual(create.title, "Fork of Investigate reconnect failures");
    assert.strictEqual(create.forkedFromThreadId, PARENT_THREAD_ID);
    const cursor = create.resumeCursor as {
      threadId: string;
      resume: string;
      turnCount: number;
    };
    assert.strictEqual(cursor.threadId, result.threadId);
    assert.strictEqual(cursor.turnCount, 0);
    assert.notStrictEqual(cursor.resume, SOURCE_SESSION_ID, "fork must yield a NEW session id");
  }),
);

it.effect("persists the new thread's binding before returning", () =>
  Effect.gen(function* () {
    ensureTempClaudeHome();
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      yield* seedParentBinding({
        threadId: PARENT_THREAD_ID,
        resume: SOURCE_SESSION_ID,
        turnCount: 1,
      });
      const result = yield* callForkThread(harness);

      const directory = yield* ProviderSessionDirectory;
      const binding = Option.getOrUndefined(yield* directory.getBinding(result.threadId));
      assert.ok(binding, "new thread must have a persisted binding");
      assert.strictEqual(binding.provider, "claudeAgent");
      assert.strictEqual(binding.providerInstanceId, "claudeAgent");
      const cursor = binding.resumeCursor as { resume: string };
      assert.notStrictEqual(cursor.resume, SOURCE_SESSION_ID);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("rejects forking a thread with no Claude session", () =>
  Effect.gen(function* () {
    ensureTempClaudeHome();
    const harness = makeHarness();
    const error = yield* Effect.flip(callForkThread(harness).pipe(Effect.provide(harness.layer)));
    assert.strictEqual(error._tag, "ThreadForkError");
    if (error._tag === "ThreadForkError") {
      assert.strictEqual(error.reason, "no-session");
    }
    assert.strictEqual(harness.dispatched.length, 0);
  }),
);

it.effect("rejects forking a non-Claude thread", () =>
  Effect.gen(function* () {
    ensureTempClaudeHome();
    const harness = makeHarness({
      shell: parentShell({ instanceId: "codex" }),
      driverKind: "codex",
    });
    const error = yield* Effect.flip(callForkThread(harness).pipe(Effect.provide(harness.layer)));
    assert.strictEqual(error._tag, "ThreadForkError");
    if (error._tag === "ThreadForkError") {
      assert.strictEqual(error.reason, "unsupported");
    }
  }),
);

it.effect("rejects forking an unknown thread", () =>
  Effect.gen(function* () {
    ensureTempClaudeHome();
    const harness = makeHarness({ shell: undefined });
    const error = yield* Effect.flip(callForkThread(harness).pipe(Effect.provide(harness.layer)));
    assert.strictEqual(error._tag, "ThreadForkError");
    if (error._tag === "ThreadForkError") {
      assert.strictEqual(error.reason, "not-found");
    }
  }),
);

it.effect("deletes the new thread when cursor seeding fails", () =>
  Effect.gen(function* () {
    ensureTempClaudeHome();
    const dispatched: Array<OrchestrationCommand> = [];
    const shell = parentShell();

    // Mocked directory: the parent binding resolves, but persisting the new
    // thread's binding fails — the exact half-created state the cleanup path
    // exists for.
    const layer = Layer.mergeAll(
      Layer.mock(ProviderSessionDirectory)({
        getBinding: (threadId) =>
          Effect.succeed(
            threadId === PARENT_THREAD_ID
              ? Option.some({
                  threadId: PARENT_THREAD_ID,
                  provider: ProviderDriverKind.make("claudeAgent"),
                  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                  resumeCursor: {
                    threadId: PARENT_THREAD_ID,
                    resume: SOURCE_SESSION_ID,
                    turnCount: 1,
                  },
                })
              : Option.none(),
          ),
        upsert: () =>
          Effect.fail(
            new ProviderValidationError({
              operation: "test.upsert",
              issue: "injected upsert failure",
            }),
          ),
      }),
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.succeed(Option.some(shell)),
      }),
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) => {
          dispatched.push(command);
          return Effect.succeed({ sequence: dispatched.length });
        },
      }),
      Layer.mock(ProviderService)({
        getInstanceInfo: (instanceId) =>
          Effect.succeed({
            instanceId,
            driverKind: ProviderDriverKind.make("claudeAgent"),
            displayName: "Claude Code",
            enabled: true,
            continuationIdentity: {
              driverKind: ProviderDriverKind.make("claudeAgent"),
              continuationKey: `claudeAgent:instance:${instanceId}`,
            },
          }),
      }),
      cryptoLayer,
      NodeServices.layer,
      emptyWatcherLayer,
    );

    const observeRpcEffect = (<A, E, R>(_method: string, effect: Effect.Effect<A, E, R>) =>
      effect) as Parameters<typeof makeThreadForkWsHandlers>[0]["observeRpcEffect"];

    const error = yield* Effect.flip(
      Effect.gen(function* () {
        const handlers = yield* makeThreadForkWsHandlers({ observeRpcEffect });
        return yield* handlers[THREAD_FORK_WS_METHODS.forkThread]({ threadId: PARENT_THREAD_ID });
      }).pipe(Effect.provide(layer)),
    );

    assert.strictEqual(error._tag, "ThreadForkError");
    if (error._tag === "ThreadForkError") {
      assert.strictEqual(error.reason, "create-failed");
    }
    const deleteCommand = dispatched.find((command) => command.type === "thread.delete");
    assert.ok(deleteCommand, "the half-created thread must be deleted");
  }),
);

// ── adopt-as-thread ──────────────────────────────────────────────────

const externalSnapshot = (overrides?: {
  readonly cwd?: string | null;
}): ExternalSessionsWatcher.ExternalSessionSnapshot => ({
  sessionId: SOURCE_SESSION_ID,
  projectSlug: "C--fake-project",
  filePath: `C:/fake/projects/C--fake-project/${SOURCE_SESSION_ID}.jsonl`,
  cwd: overrides && "cwd" in overrides ? (overrides.cwd ?? null) : "C:\\fake\\project",
  title: "Investigating the widget",
  state: "idle",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
});

const makeAdoptHarness = (options?: {
  readonly session?: ExternalSessionsWatcher.ExternalSessionSnapshot | undefined;
  readonly ownSessionIds?: ReadonlyArray<string>;
  readonly worktreeThreads?: ReadonlyArray<{ worktreePath: string; projectId: string }>;
}) => {
  const dispatched: Array<OrchestrationCommand> = [];
  const session = "session" in (options ?? {}) ? options?.session : externalSnapshot();

  const layer = Layer.mergeAll(
    ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntime.layer),
      Layer.provide(SqlitePersistenceMemory),
    ),
    Layer.mock(ExternalSessionsWatcher.ExternalSessionsWatcher)({
      snapshot: Effect.succeed(session === undefined ? [] : [session]),
    }),
    Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [
            {
              id: "project-1",
              title: "Fake project",
              workspaceRoot: "C:\\fake\\project",
              repositoryIdentity: null,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          threads: (options?.worktreeThreads ?? []).map((entry) => ({
            ...parentShell(),
            id: ThreadId.make(`thread-worktree-${entry.worktreePath}`),
            projectId: entry.projectId,
            worktreePath: entry.worktreePath,
          })),
          updatedAt: "2026-01-01T00:00:00.000Z",
        } as never),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: dispatched.length });
      },
    }),
    Layer.mock(ProviderService)({
      getInstanceInfo: (instanceId) =>
        Effect.succeed({
          instanceId,
          driverKind: ProviderDriverKind.make("claudeAgent"),
          displayName: "Claude Code",
          enabled: true,
          continuationIdentity: {
            driverKind: ProviderDriverKind.make("claudeAgent"),
            continuationKey: `claudeAgent:instance:${instanceId}`,
          },
        }),
      listSessions: () =>
        Effect.succeed(
          (options?.ownSessionIds ?? []).map(
            (sessionId) =>
              ({
                threadId: ThreadId.make(`thread-own-${sessionId}`),
                provider: ProviderDriverKind.make("claudeAgent"),
                providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                status: "running",
                resumeCursor: { resume: sessionId },
              }) as never,
          ),
        ),
    }),
    cryptoLayer,
    NodeServices.layer,
  );

  const observeRpcEffect = (<A, E, R>(_method: string, effect: Effect.Effect<A, E, R>) =>
    effect) as Parameters<typeof makeThreadForkWsHandlers>[0]["observeRpcEffect"];

  return { layer, dispatched, observeRpcEffect };
};

const claudeSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-6",
};

const callAdopt = (
  harness: ReturnType<typeof makeAdoptHarness>,
  modelSelection: typeof claudeSelection = claudeSelection,
) =>
  Effect.gen(function* () {
    const handlers = yield* makeThreadForkWsHandlers({
      observeRpcEffect: harness.observeRpcEffect,
    });
    return yield* handlers[THREAD_FORK_WS_METHODS.adoptExternalSession]({
      sessionId: SOURCE_SESSION_ID,
      modelSelection,
    });
  });

it.effect("adopts an external session into a seeded thread in the matched project", () =>
  Effect.gen(function* () {
    ensureTempClaudeHome();
    const harness = makeAdoptHarness();
    yield* Effect.gen(function* () {
      const result = yield* callAdopt(harness);

      const create = harness.dispatched.find((command) => command.type === "thread.create");
      assert.ok(create && create.type === "thread.create");
      assert.strictEqual(create.threadId, result.threadId);
      assert.strictEqual(create.projectId, "project-1");
      assert.strictEqual(create.title, "Investigating the widget");
      assert.strictEqual(create.worktreePath, null, "cwd == workspace root needs no worktree");
      assert.strictEqual(create.forkedFromThreadId, undefined);
      const cursor = create.resumeCursor as { resume: string };
      assert.notStrictEqual(cursor.resume, SOURCE_SESSION_ID, "adopt must fork, never extend");

      const directory = yield* ProviderSessionDirectory;
      const binding = Option.getOrUndefined(yield* directory.getBinding(result.threadId));
      assert.ok(binding, "adopted thread must have a persisted binding");
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("records the session cwd as worktreePath when it isn't the project root", () =>
  Effect.gen(function* () {
    ensureTempClaudeHome();
    const worktree = "C:\\fake\\project-worktree";
    const harness = makeAdoptHarness({
      session: externalSnapshot({ cwd: worktree }),
      worktreeThreads: [{ worktreePath: worktree, projectId: "project-1" }],
    });
    yield* Effect.gen(function* () {
      yield* callAdopt(harness);
      const create = harness.dispatched.find((command) => command.type === "thread.create");
      assert.ok(create && create.type === "thread.create");
      assert.strictEqual(create.worktreePath, worktree);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("rejects adopting a session t3 already owns", () =>
  Effect.gen(function* () {
    ensureTempClaudeHome();
    const harness = makeAdoptHarness({ ownSessionIds: [SOURCE_SESSION_ID] });
    const error = yield* Effect.flip(callAdopt(harness).pipe(Effect.provide(harness.layer)));
    assert.strictEqual(error._tag, "ThreadForkError");
    if (error._tag === "ThreadForkError") {
      assert.strictEqual(error.reason, "unsupported");
    }
  }),
);

it.effect("rejects adopting a session whose cwd matches no project", () =>
  Effect.gen(function* () {
    ensureTempClaudeHome();
    const harness = makeAdoptHarness({
      session: externalSnapshot({ cwd: "D:\\somewhere\\else" }),
    });
    const error = yield* Effect.flip(callAdopt(harness).pipe(Effect.provide(harness.layer)));
    assert.strictEqual(error._tag, "ThreadForkError");
    if (error._tag === "ThreadForkError") {
      assert.strictEqual(error.reason, "no-project");
    }
    assert.strictEqual(harness.dispatched.length, 0);
  }),
);

it.effect("rejects adopting an unknown session", () =>
  Effect.gen(function* () {
    ensureTempClaudeHome();
    const harness = makeAdoptHarness({ session: undefined });
    const error = yield* Effect.flip(callAdopt(harness).pipe(Effect.provide(harness.layer)));
    assert.strictEqual(error._tag, "ThreadForkError");
    if (error._tag === "ThreadForkError") {
      assert.strictEqual(error.reason, "not-found");
    }
  }),
);

// The seed path uses the parent's binding instance, not the (possibly stale)
// thread model selection, so the first turn's instance check matches.
it.effect("keeps the binding instance when it differs from the thread selection", () =>
  Effect.gen(function* () {
    ensureTempClaudeHome();
    const harness = makeHarness({
      shell: parentShell({ instanceId: "claude_personal" }),
    });
    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        threadId: PARENT_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        status: "stopped",
        resumeCursor: { threadId: PARENT_THREAD_ID, resume: SOURCE_SESSION_ID, turnCount: 1 },
      });
      const result = yield* callForkThread(harness);

      const create = harness.dispatched.find((command) => command.type === "thread.create");
      assert.ok(create && create.type === "thread.create");
      assert.strictEqual(
        create.modelSelection.instanceId,
        ProviderInstanceId.make("claudeAgent"),
        "new thread must route to the binding's instance",
      );
      const binding = Option.getOrUndefined(yield* directory.getBinding(result.threadId));
      assert.strictEqual(binding?.providerInstanceId, ProviderInstanceId.make("claudeAgent"));
    }).pipe(Effect.provide(harness.layer));
  }),
);
