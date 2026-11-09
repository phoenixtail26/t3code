import {
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadStateAtoms,
  ThreadHistoryController,
  ThreadSnapshotLoader,
  type ThreadSnapshotLoadResult,
} from "@t3tools/client-runtime/state/threads";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { stubGlobal } from "../../test/render";
import { DraftId, useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import type { SpeakRequest, SpeakResult } from "./api";
import { bindDictatedMark, clearDictatedMarks, markDraftDictated } from "./dictatedMark";
import { startReadAloud, stopReadAloud } from "./player";
import { readReadAloudMode, setReadAloudMode } from "./setting";
import { installReadAloudTurnEnd, pendingTurnCount } from "./turnEnd";

type DetailAtoms = ReturnType<typeof createEnvironmentThreadDetailAtoms>;

const state = vi.hoisted(() => ({
  shells: new Map<string, unknown>(),
  threads: new Map<string, unknown>(),
  /** When set, the real client-runtime thread state stands behind the detail atoms. */
  details: null as null | { threadAtom: unknown; statusAtom: unknown },
  calls: [] as Array<Pick<SpeakRequest, "environmentId" | "threadId" | "messageId" | "mode">>,
}));

vi.mock(import("./api"), async () => ({
  speak: async (input: SpeakRequest): Promise<SpeakResult> => {
    state.calls.push({
      environmentId: input.environmentId,
      threadId: input.threadId,
      messageId: input.messageId,
      ...(input.mode ? { mode: input.mode } : {}),
    });
    input.onFormat(24_000);
    input.onChunk(new Uint8Array([0, 0x40]));
    return { ok: true };
  },
}));
vi.mock(import("../state/threads"), async (original) => {
  const actual = await original();
  const key = (ref: { environmentId: string; threadId: string }) =>
    `${ref.environmentId}:${ref.threadId}`;
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      quietThreadShellAtom: ((ref: { environmentId: string; threadId: string }) =>
        state.shells.get(key(ref))) as never,
    },
    environmentThreadDetails: {
      ...actual.environmentThreadDetails,
      threadAtom: ((ref: { environmentId: string; threadId: string }) =>
        state.details
          ? (state.details.threadAtom as DetailAtoms["threadAtom"])(ref as never)
          : state.threads.get(key(ref))) as never,
      statusAtom: ((ref: { environmentId: string; threadId: string }) =>
        (state.details!.statusAtom as DetailAtoms["statusAtom"])(ref as never)) as never,
    },
  };
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-auto");
const THREAD_REF = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };
const THREAD_KEY = `${ENVIRONMENT_ID}:${THREAD_ID}`;
const DRAFT = DraftId.make("draft-auto");
const SENT = MessageId.make("user-1");
const REPLY = MessageId.make("reply-1");
const RUN = RunId.make("run-1");
const SENT_2 = MessageId.make("user-2");
const REPLY_2 = MessageId.make("reply-2");
const RUN_2 = RunId.make("run-2");

class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect() {}
  start() {}
  stop() {
    this.onended?.();
  }
}
class FakeAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return {
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
    };
  }
  createBufferSource() {
    return new FakeSource();
  }
}

type RunStatus = OrchestrationV2ThreadProjection["runs"][number]["status"];

interface Turn {
  readonly sent: MessageId;
  /** The run the message started; null while it waits in the queue. */
  readonly runId?: RunId | null;
  readonly status?: RunStatus;
  readonly reply?: { id?: MessageId; streaming?: boolean; text?: string } | null;
}

/** The thread's projection as the client sees it: each sent message, its run, its reply. */
function projection(...turns: Turn[]): OrchestrationV2ThreadProjection {
  const messages = turns.flatMap((turn) => {
    const runId = turn.runId === undefined ? RUN : turn.runId;
    return [
      { id: turn.sent, role: "user", runId, text: "Build it.", streaming: false },
      ...(turn.reply
        ? [
            {
              id: turn.reply.id ?? REPLY,
              role: "assistant",
              runId,
              text: turn.reply.text ?? "Built.",
              streaming: turn.reply.streaming ?? false,
            },
          ]
        : []),
    ];
  });
  const runs = turns.flatMap((turn) => {
    const runId = turn.runId === undefined ? RUN : turn.runId;
    return runId === null ? [] : [{ id: runId, status: turn.status ?? "running" }];
  });
  return { messages, runs } as unknown as OrchestrationV2ThreadProjection;
}

function detail(...turns: Turn[]): EnvironmentThread {
  return { environmentId: ENVIRONMENT_ID, projection: projection(...turns) };
}

/** The thread's shell, as far as the watcher reads it: the latest run and its status. */
function shell(runId: RunId | null, status: RunStatus = "running"): EnvironmentThreadShell {
  return {
    id: THREAD_ID,
    environmentId: ENVIRONMENT_ID,
    latestRun: runId === null ? null : { runId, status },
  } as unknown as EnvironmentThreadShell;
}

async function setup() {
  stopReadAloud();
  clearDictatedMarks();
  window.localStorage.clear();
  state.calls = [];
  state.shells.clear();
  state.threads.clear();
  state.details = null;
  const shellAtom = Atom.make<EnvironmentThreadShell | null>(null);
  const thread = Atom.make<EnvironmentThread | null>(null);
  state.shells.set(THREAD_KEY, shellAtom);
  state.threads.set(THREAD_KEY, thread);
  const registry = AtomRegistry.make();
  const drafts = useComposerDraftStore.getState();
  drafts.setPrompt(THREAD_REF, "");
  drafts.setPrompt(DRAFT, "");
  // The page has been touched, as it was when the microphone was pressed.
  await userEvent.click(document.body);
  return { registry, shellAtom, thread };
}

/** Sends the draft under `target` as `messageId`, dictated or typed, the way the composer does. */
function send(dictated: boolean, messageId = SENT, target: ComposerThreadTarget = THREAD_REF) {
  const drafts = useComposerDraftStore.getState();
  drafts.setPrompt(target, dictated ? "build it, spoken" : "build it, typed");
  if (dictated) markDraftDictated(target);
  bindDictatedMark(target, ENVIRONMENT_ID, THREAD_ID, messageId);
  drafts.setPrompt(target, "");
}

it("defaults to dictated and keeps the choice in this browser", () => {
  window.localStorage.clear();
  expect(readReadAloudMode()).toBe("dictated");
  setReadAloudMode("always");
  expect(readReadAloudMode()).toBe("always");
  expect(window.localStorage.getItem("t3code:read-aloud:v1")).toBe("always");
  window.localStorage.setItem("t3code:read-aloud:v1", "nonsense");
  expect(readReadAloudMode()).toBe("dictated");
});

it("summarises a dictated turn's reply once its run completes, and nothing sooner", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, shellAtom, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  send(true);
  expect(pendingTurnCount()).toBe(1);
  registry.set(thread, detail({ sent: SENT, status: "completed", reply: {} }));
  // The shell has not shown the run's end: the detail is not read, whatever it holds.
  registry.set(shellAtom, shell(null));
  registry.set(shellAtom, shell(RUN, "running"));
  expect(state.calls).toEqual([]);
  registry.set(shellAtom, shell(RUN, "completed"));
  expect(state.calls).toEqual([
    { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID, messageId: REPLY, mode: "summary" },
  ]);
  expect(pendingTurnCount()).toBe(0);
  // The run is over; a later change to the thread says nothing more.
  registry.set(thread, detail({ sent: SENT, status: "completed", reply: { text: "Again." } }));
  expect(state.calls).toHaveLength(1);
});

it("waits for the reply when the shell ends the run before the detail shows it", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, shellAtom, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  send(true);
  registry.set(thread, detail({ sent: SENT, reply: { streaming: true } }));
  registry.set(shellAtom, shell(RUN, "completed"));
  expect(state.calls).toEqual([]);
  registry.set(thread, detail({ sent: SENT, status: "completed", reply: {} }));
  expect(state.calls.map((call) => call.messageId)).toEqual([REPLY]);
});

it("stays silent for a typed turn, and for a dictated one when the setting is off", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, shellAtom, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  send(false);
  registry.set(thread, detail({ sent: SENT, status: "completed", reply: {} }));
  registry.set(shellAtom, shell(RUN, "completed"));
  expect(state.calls).toEqual([]);
  setReadAloudMode("off");
  send(true, SENT_2);
  registry.set(
    thread,
    detail(
      { sent: SENT, status: "completed", reply: {} },
      { sent: SENT_2, runId: RUN_2, status: "completed", reply: { id: REPLY_2 } },
    ),
  );
  registry.set(shellAtom, shell(RUN_2, "completed"));
  expect(state.calls).toEqual([]);
  expect(pendingTurnCount()).toBe(0);
});

it("summarises every turn this client sent when the setting is always", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, shellAtom, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  setReadAloudMode("always");
  send(false);
  registry.set(thread, detail({ sent: SENT, status: "completed", reply: {} }));
  registry.set(shellAtom, shell(RUN, "completed"));
  expect(state.calls.map((call) => call.mode)).toEqual(["summary"]);
});

it("keeps a dictated turn's summary when a typed follow-up is sent on the same thread", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, shellAtom, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  registry.set(shellAtom, shell(RUN, "running"));
  send(true);
  send(false, SENT_2);
  // The dictated run completes while the typed follow-up's run takes its place in the shell.
  registry.set(
    thread,
    detail({ sent: SENT, status: "completed", reply: {} }, { sent: SENT_2, runId: RUN_2 }),
  );
  registry.set(shellAtom, shell(RUN_2, "running"));
  expect(state.calls.map((call) => call.messageId)).toEqual([REPLY]);
  stopReadAloud();
  registry.set(
    thread,
    detail(
      { sent: SENT, status: "completed", reply: {} },
      { sent: SENT_2, runId: RUN_2, status: "completed", reply: { id: REPLY_2 } },
    ),
  );
  registry.set(shellAtom, shell(RUN_2, "completed"));
  expect(state.calls.map((call) => call.messageId)).toEqual([REPLY]);
  expect(pendingTurnCount()).toBe(0);
});

it("keeps the mark on a draft the store files under a draft id", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, shellAtom, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  const drafts = useComposerDraftStore.getState();
  drafts.setPrompt(DRAFT, "build it, spoken");
  markDraftDictated(DRAFT);
  // Other drafts come and go without touching this one.
  drafts.setPrompt(THREAD_REF, "something else");
  drafts.setPrompt(THREAD_REF, "");
  bindDictatedMark(DRAFT, ENVIRONMENT_ID, THREAD_ID, SENT);
  drafts.setPrompt(DRAFT, "");
  registry.set(thread, detail({ sent: SENT, status: "completed", reply: {} }));
  registry.set(shellAtom, shell(RUN, "completed"));
  expect(state.calls.map((call) => call.messageId)).toEqual([REPLY]);
});

it("forgets the mark when the dictated draft is emptied before it is sent", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, shellAtom, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  const drafts = useComposerDraftStore.getState();
  drafts.setPrompt(THREAD_REF, "fix the build");
  markDraftDictated(THREAD_REF);
  drafts.setPrompt(THREAD_REF, "fix the build and the tests");
  drafts.setPrompt(THREAD_REF, "");
  drafts.setPrompt(THREAD_REF, "typed afresh");
  bindDictatedMark(THREAD_REF, ENVIRONMENT_ID, THREAD_ID, SENT);
  registry.set(thread, detail({ sent: SENT, status: "completed", reply: {} }));
  registry.set(shellAtom, shell(RUN, "completed"));
  expect(state.calls).toEqual([]);
});

it("keeps the mark for the retry when a send fails and the draft comes back", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, shellAtom, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  const drafts = useComposerDraftStore.getState();
  // The send clears the draft, fails, and restores the same words; the retry sends them.
  drafts.setPrompt(THREAD_REF, "build it, spoken");
  markDraftDictated(THREAD_REF);
  bindDictatedMark(THREAD_REF, ENVIRONMENT_ID, THREAD_ID, SENT);
  drafts.setPrompt(THREAD_REF, "");
  drafts.setPrompt(THREAD_REF, "build it, spoken");
  bindDictatedMark(THREAD_REF, ENVIRONMENT_ID, THREAD_ID, SENT_2);
  drafts.setPrompt(THREAD_REF, "");
  registry.set(
    thread,
    detail({ sent: SENT_2, runId: RUN_2, status: "completed", reply: { id: REPLY_2 } }),
  );
  registry.set(shellAtom, shell(RUN_2, "completed"));
  expect(state.calls.map((call) => call.messageId)).toEqual([REPLY_2]);
  // The rejected send's own entry waits until it is evicted; different words typed afterwards
  // are typed, not the restored dictation, so they add nothing.
  expect(pendingTurnCount()).toBe(1);
  drafts.setPrompt(THREAD_REF, "something typed");
  bindDictatedMark(THREAD_REF, ENVIRONMENT_ID, THREAD_ID, MessageId.make("user-3"));
  expect(pendingTurnCount()).toBe(1);
});

it("says nothing for a run that failed, and never cuts off a reply being read", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, shellAtom, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  send(true);
  registry.set(thread, detail({ sent: SENT, status: "failed", reply: {} }));
  registry.set(shellAtom, shell(RUN, "failed"));
  expect(state.calls).toEqual([]);
  expect(pendingTurnCount()).toBe(0);
  // A reply the person asked for is playing when the next dictated turn ends.
  startReadAloud({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID, messageId: REPLY });
  await vi.waitFor(() => expect(state.calls).toHaveLength(1));
  send(true, SENT_2);
  registry.set(
    thread,
    detail(
      { sent: SENT, status: "failed", reply: {} },
      { sent: SENT_2, runId: RUN_2, status: "completed", reply: { id: REPLY_2 } },
    ),
  );
  registry.set(shellAtom, shell(RUN_2, "completed"));
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]!.mode).toBeUndefined();
  stopReadAloud();
});

// The real client-runtime thread state behind the detail atoms, driven by a snapshot loader.

const TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

/** The thread detail atoms over the real thread state, with a snapshot loader the test drives. */
function makeThreadAtoms(load: () => ThreadSnapshotLoadResult) {
  // The services are made when the runtime first builds its layer, on the first subscription.
  const layer = Layer.unwrap(
    Effect.gen(function* () {
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: () => Stream.never,
      } as unknown as WsRpcProtocolClient;
      const session = {
        client,
        initialConfig: Effect.succeed({
          threadResumeCompletionMarker: true,
          threadSnapshotPagination: true,
        }),
        subscribeServerConfig: () => Stream.never,
        ready: Effect.void,
        probe: Effect.void,
        inboundFrames: Effect.succeed(0),
        closed: Effect.never,
      } as unknown as RpcSession;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
          Option.some({
            environmentId: ENVIRONMENT_ID,
            label: TARGET.label,
            httpBaseUrl: TARGET.httpBaseUrl,
            socketUrl: TARGET.wsBaseUrl,
            httpAuthorization: null,
            target: TARGET,
          }),
        ),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
        entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          new Map(),
        ),
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        start: Effect.void,
        register: () => Effect.die("Unexpected environment registration"),
        assertKnownAddress: () => Effect.die("Unexpected address check"),
        reconcilePlatform: () => Effect.die("Unexpected environment reconciliation"),
        remove: () => Effect.die("Unexpected environment removal"),
        removeRoute: () => Effect.die("Unexpected route removal"),
        reorderRoutes: () => Effect.die("Unexpected route reorder"),
        removeRelayEnvironments: () => Effect.die("Unexpected environment removal"),
        retryNow: () => Effect.void,
        setEnabled: () => Effect.die("Unexpected environment toggle"),
        setCompatibility: () => Effect.die("Unexpected compatibility update"),
        state: () => SubscriptionRef.get(supervisor.state),
        stateChanges: () => SubscriptionRef.changes(supervisor.state),
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        runStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      });
      const historyController = yield* Effect.service(
        ThreadHistoryController.ThreadHistoryController,
      ).pipe(Effect.provide(ThreadHistoryController.layer));
      return Layer.mergeAll(
        Layer.succeed(ThreadHistoryController.ThreadHistoryController, historyController),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("No HTTP is expected here")),
        ),
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        Layer.succeed(
          Persistence.EnvironmentCacheStore,
          Persistence.EnvironmentCacheStore.of({
            loadShell: () => Effect.succeedNone,
            saveShell: () => Effect.void,
            loadThread: () => Effect.succeedNone,
            saveThread: () => Effect.void,
            removeThread: () => Effect.void,
            loadServerConfig: () => Effect.succeedNone,
            saveServerConfig: () => Effect.void,
            loadVcsRefs: () => Effect.succeedNone,
            saveVcsRefs: () => Effect.void,
            removeVcsRefs: () => Effect.void,
            clearVcsRefs: () => Effect.void,
            clear: () => Effect.void,
          }),
        ),
        Layer.succeed(
          ThreadSnapshotLoader,
          ThreadSnapshotLoader.of({ load: () => Effect.sync(load) }),
        ),
      );
    }),
  );
  const runtime = Atom.runtime(layer);
  return createEnvironmentThreadDetailAtoms(createEnvironmentThreadStateAtoms(runtime).stateAtom);
}

it("a new thread from a draft: nothing loads until its shell ends the run, then the summary plays", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, shellAtom } = await setup();
  // The server has not created the thread yet: a snapshot load would answer 404.
  let created = false;
  let loads = 0;
  const details = makeThreadAtoms(() => {
    loads += 1;
    return created
      ? {
          _tag: "present",
          snapshot: {
            snapshotSequence: 1,
            projection: projection({ sent: SENT, status: "completed", reply: {} }),
          },
        }
      : { _tag: "missing" };
  });
  state.details = details;
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  send(true, SENT, DRAFT);
  expect(pendingTurnCount()).toBe(1);
  expect(loads).toBe(0);
  // The send creates the thread: its shell appears with the run under way.
  created = true;
  registry.set(shellAtom, shell(RUN, "running"));
  expect(loads).toBe(0);
  registry.set(shellAtom, shell(RUN, "completed"));
  await vi.waitFor(() => expect(state.calls.map((call) => call.messageId)).toEqual([REPLY]));
  expect(loads).toBe(1);
  expect(registry.get(details.statusAtom(THREAD_REF))).not.toBe("deleted");
  expect(pendingTurnCount()).toBe(0);
});
