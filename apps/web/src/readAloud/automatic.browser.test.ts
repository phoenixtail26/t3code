import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { stubGlobal } from "../../test/render";
import { useComposerDraftStore } from "~/composerDraftStore";
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
const DRAFT_KEY = scopedThreadKey(THREAD_REF);
const SENT = MessageId.make("user-1");
const REPLY = MessageId.make("reply-1");
const RUN = RunId.make("run-1");

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

/** The thread as the client sees it: the sent message, its run, and the reply once there. */
function projection(input: {
  runId?: RunId | null;
  status?: RunStatus;
  reply?: { streaming?: boolean; text?: string } | null;
}): EnvironmentThread {
  const runId = input.runId === undefined ? RUN : input.runId;
  const messages = [
    { id: SENT, role: "user", runId, text: "Build it.", streaming: false },
    ...(input.reply
      ? [
          {
            id: REPLY,
            role: "assistant",
            runId: RUN,
            text: input.reply.text ?? "Built.",
            streaming: input.reply.streaming ?? false,
          },
        ]
      : []),
  ];
  const runs = runId === null ? [] : [{ id: runId, status: input.status ?? "running" }];
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
  useComposerDraftStore.getState().setPrompt(THREAD_REF, "");
  // The page has been touched, as it was when the microphone was pressed.
  await userEvent.click(document.body);
  return { registry, thread };
}

function send(dictated: boolean) {
  if (dictated) markDraftDictated(DRAFT_KEY);
  bindDictatedMark(THREAD_REF, ENVIRONMENT_ID, THREAD_ID, SENT);
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
  registry.set(thread, projection({ runId: null }));
  registry.set(thread, projection({ status: "running", reply: { streaming: true } }));
  expect(state.calls).toEqual([]);
  registry.set(thread, projection({ status: "completed", reply: {} }));
  expect(state.calls).toEqual([
    { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID, messageId: REPLY, mode: "summary" },
  ]);
  expect(pendingTurnCount()).toBe(0);
  // The run is over; a later change to the thread says nothing more.
  registry.set(thread, projection({ status: "completed", reply: { text: "Built again." } }));
  expect(state.calls).toHaveLength(1);
});

it("stays silent for a typed turn, and for a dictated one when the setting is off", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  send(false);
  registry.set(thread, projection({ status: "completed", reply: {} }));
  expect(state.calls).toEqual([]);
  setReadAloudMode("off");
  send(true);
  registry.set(thread, projection({ status: "running", reply: null }));
  registry.set(thread, projection({ status: "completed", reply: {} }));
  expect(state.calls).toEqual([]);
  expect(pendingTurnCount()).toBe(0);
});

it("summarises every turn this client sent when the setting is always", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  setReadAloudMode("always");
  send(false);
  registry.set(thread, projection({ status: "completed", reply: {} }));
  expect(state.calls.map((call) => call.mode)).toEqual(["summary"]);
});

it("forgets the mark when the dictated draft is emptied before it is sent", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  const drafts = useComposerDraftStore.getState();
  drafts.setPrompt(THREAD_REF, "fix the build");
  markDraftDictated(DRAFT_KEY);
  drafts.setPrompt(THREAD_REF, "fix the build and the tests");
  drafts.setPrompt(THREAD_REF, "");
  drafts.setPrompt(THREAD_REF, "typed afresh");
  bindDictatedMark(THREAD_REF, ENVIRONMENT_ID, THREAD_ID, SENT);
  registry.set(thread, projection({ status: "completed", reply: {} }));
  expect(state.calls).toEqual([]);
});

it("says nothing for a run that failed, and never cuts off a reply being read", async () => {
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const { registry, thread } = await setup();
  using _watcher = { [Symbol.dispose]: installReadAloudTurnEnd(registry) };
  send(true);
  registry.set(thread, projection({ status: "failed", reply: {} }));
  expect(state.calls).toEqual([]);
  expect(pendingTurnCount()).toBe(0);
  // A reply the person asked for is playing when the next dictated turn ends.
  startReadAloud({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID, messageId: REPLY });
  await vi.waitFor(() => expect(state.calls).toHaveLength(1));
  send(true);
  registry.set(thread, projection({ status: "running", reply: null }));
  registry.set(thread, projection({ status: "completed", reply: {} }));
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]!.mode).toBeUndefined();
  stopReadAloud();
});
