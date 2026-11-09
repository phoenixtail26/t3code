import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
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

const state = vi.hoisted(() => ({
  threads: new Map<string, unknown>(),
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
  return {
    ...actual,
    environmentThreadDetails: {
      ...actual.environmentThreadDetails,
      threadAtom: ((ref: { environmentId: string; threadId: string }) =>
        state.threads.get(`${ref.environmentId}:${ref.threadId}`)) as never,
    },
  };
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-auto");
const THREAD_REF = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };
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

/** The thread as the client sees it: each sent message, its run, and the reply once there. */
function projection(...turns: Turn[]): EnvironmentThread {
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
  return {
    environmentId: ENVIRONMENT_ID,
    projection: { messages, runs } as unknown as OrchestrationV2ThreadProjection,
  };
}

async function setup() {
  stopReadAloud();
  clearDictatedMarks();
  window.localStorage.clear();
  state.calls = [];
  state.threads.clear();
  const thread = Atom.make<EnvironmentThread | null>(null);
  state.threads.set(`${ENVIRONMENT_ID}:${THREAD_ID}`, thread);
  const registry = AtomRegistry.make();
  const drafts = useComposerDraftStore.getState();
  drafts.setPrompt(THREAD_REF, "");
  drafts.setPrompt(DRAFT, "");
  // The page has been touched, as it was when the microphone was pressed.
  await userEvent.click(document.body);
  return { registry, thread };
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
  const { registry, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  send(true);
  expect(pendingTurnCount()).toBe(1);
  registry.set(thread, projection({ sent: SENT, runId: null }));
  registry.set(thread, projection({ sent: SENT, reply: { streaming: true } }));
  expect(state.calls).toEqual([]);
  registry.set(thread, projection({ sent: SENT, status: "completed", reply: {} }));
  expect(state.calls).toEqual([
    { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID, messageId: REPLY, mode: "summary" },
  ]);
  expect(pendingTurnCount()).toBe(0);
  // The run is over; a later change to the thread says nothing more.
  registry.set(
    thread,
    projection({ sent: SENT, status: "completed", reply: { text: "Built again." } }),
  );
  expect(state.calls).toHaveLength(1);
});

it("stays silent for a typed turn, and for a dictated one when the setting is off", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  send(false);
  registry.set(thread, projection({ sent: SENT, status: "completed", reply: {} }));
  expect(state.calls).toEqual([]);
  setReadAloudMode("off");
  send(true, SENT_2);
  registry.set(
    thread,
    projection({ sent: SENT, status: "completed", reply: {} }, { sent: SENT_2, runId: RUN_2 }),
  );
  registry.set(
    thread,
    projection(
      { sent: SENT, status: "completed", reply: {} },
      { sent: SENT_2, runId: RUN_2, status: "completed", reply: { id: REPLY_2 } },
    ),
  );
  expect(state.calls).toEqual([]);
  expect(pendingTurnCount()).toBe(0);
});

it("summarises every turn this client sent when the setting is always", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  setReadAloudMode("always");
  send(false);
  registry.set(thread, projection({ sent: SENT, status: "completed", reply: {} }));
  expect(state.calls.map((call) => call.mode)).toEqual(["summary"]);
});

it("keeps a dictated turn's summary when a typed follow-up is sent on the same thread", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  send(true);
  send(false, SENT_2);
  // The dictated run completes first, then the typed follow-up's run.
  registry.set(
    thread,
    projection({ sent: SENT, status: "completed", reply: {} }, { sent: SENT_2, runId: RUN_2 }),
  );
  expect(state.calls.map((call) => call.messageId)).toEqual([REPLY]);
  stopReadAloud();
  registry.set(
    thread,
    projection(
      { sent: SENT, status: "completed", reply: {} },
      { sent: SENT_2, runId: RUN_2, status: "completed", reply: { id: REPLY_2 } },
    ),
  );
  expect(state.calls.map((call) => call.messageId)).toEqual([REPLY]);
  expect(pendingTurnCount()).toBe(0);
});

it("keeps the mark on a draft the store files under a draft id", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  const drafts = useComposerDraftStore.getState();
  drafts.setPrompt(DRAFT, "build it, spoken");
  markDraftDictated(DRAFT);
  // Other drafts come and go without touching this one.
  drafts.setPrompt(THREAD_REF, "something else");
  drafts.setPrompt(THREAD_REF, "");
  bindDictatedMark(DRAFT, ENVIRONMENT_ID, THREAD_ID, SENT);
  drafts.setPrompt(DRAFT, "");
  registry.set(thread, projection({ sent: SENT, status: "completed", reply: {} }));
  expect(state.calls.map((call) => call.messageId)).toEqual([REPLY]);
});

it("forgets the mark when the dictated draft is emptied before it is sent", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  const drafts = useComposerDraftStore.getState();
  drafts.setPrompt(THREAD_REF, "fix the build");
  markDraftDictated(THREAD_REF);
  drafts.setPrompt(THREAD_REF, "fix the build and the tests");
  drafts.setPrompt(THREAD_REF, "");
  drafts.setPrompt(THREAD_REF, "typed afresh");
  bindDictatedMark(THREAD_REF, ENVIRONMENT_ID, THREAD_ID, SENT);
  registry.set(thread, projection({ sent: SENT, status: "completed", reply: {} }));
  expect(state.calls).toEqual([]);
});

it("says nothing for a run that failed, and never cuts off a reply being read", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  send(true);
  registry.set(thread, projection({ sent: SENT, status: "failed", reply: {} }));
  expect(state.calls).toEqual([]);
  expect(pendingTurnCount()).toBe(0);
  // A reply the person asked for is playing when the next dictated turn ends.
  startReadAloud({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID, messageId: REPLY });
  await vi.waitFor(() => expect(state.calls).toHaveLength(1));
  send(true, SENT_2);
  registry.set(
    thread,
    projection(
      { sent: SENT, status: "failed", reply: {} },
      { sent: SENT_2, runId: RUN_2, status: "completed", reply: { id: REPLY_2 } },
    ),
  );
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]!.mode).toBeUndefined();
  stopReadAloud();
});
