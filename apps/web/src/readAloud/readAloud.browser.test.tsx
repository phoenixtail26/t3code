import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ProjectedTurnItem,
  type ServerSettings,
} from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { createRef, type ComponentProps } from "react";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render, stubGlobal } from "../../test/render";
import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import type { SpeakRequest, SpeakResult } from "./api";
import { installReadAloudCommands } from "./commands";
import { readReadAloudState } from "./store";

const state = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  items: null as unknown,
  calls: [] as Array<Pick<SpeakRequest, "environmentId" | "threadId" | "messageId">>,
  stops: [] as Array<Promise<void>>,
  answer: null as null | ((input: SpeakRequest) => Promise<SpeakResult>),
}));

vi.mock(import("./api"), async () => ({
  speak: async (input: SpeakRequest): Promise<SpeakResult> => {
    state.calls.push({
      environmentId: input.environmentId,
      threadId: input.threadId,
      messageId: input.messageId,
    });
    state.stops.push(input.stop);
    return state.answer!(input);
  },
}));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      settingsValueAtom: ((id: string) => state.settings.get(id)) as never,
    },
  };
});
vi.mock(import("../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadDetails: {
      ...actual.environmentThreadDetails,
      visibleTurnItemsAtom: (() => state.items) as never,
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-read-aloud");
const REPLY = MessageId.make("reply-1");
const LATER_STREAMING = MessageId.make("reply-2");
const RUN = RunId.make("run-1");
const CREATED_AT = "2026-03-17T19:12:28.000Z";
const REPLY_TEXT = "Done.\n\n```sh\npnpm test\n```\n\nAll green.";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect() {}
  start() {}
  stop() {
    this.onended?.();
  }
}

/** Web Audio that schedules without a clock; a test ends its sources itself. */
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly currentTime = 0;
  readonly destination = {};
  readonly sources: FakeSource[] = [];
  closed = false;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
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
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  endAll() {
    for (const source of this.sources.splice(0)) source.onended?.();
  }
}

function setup(hearsayUrl: string) {
  state.settings.clear();
  state.settings.set(
    ENVIRONMENT_ID,
    Atom.make<ServerSettings | null>({
      ...DEFAULT_SERVER_SETTINGS,
      hearsaySpeech: { url: hearsayUrl, token: "" },
    }),
  );
  const item = (id: MessageId, streaming: boolean): OrchestrationV2ProjectedTurnItem =>
    ({
      position: 0,
      visibility: "local",
      sourceThreadId: THREAD_ID,
      sourceItemId: id,
      item: {
        id,
        type: "assistant_message",
        messageId: id,
        text: REPLY_TEXT,
        streaming,
        status: streaming ? "running" : "completed",
        threadId: THREAD_ID,
        runId: RUN,
      },
    }) as unknown as OrchestrationV2ProjectedTurnItem;
  state.items = Atom.make([item(REPLY, false), item(LATER_STREAMING, true)]);
  state.calls = [];
  state.stops = [];
  // One chunk, then the request ends; the player keeps playing until the audio drains.
  state.answer = async (input) => {
    input.onFormat(24_000);
    input.onChunk(new Uint8Array([0, 0x40, 0, 0xc0, 1]));
    return { ok: true };
  };
  FakeAudioContext.instances = [];
}

const router = {
  state: { matches: [{ params: { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID } }] },
} as unknown as AnyRouter;

function entry(id: MessageId, text = REPLY_TEXT, streaming = false): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id,
      role: "assistant",
      text,
      runId: RUN,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming,
    },
  } as Entry;
}

function timelineProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    listRef: createRef(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `${ENVIRONMENT_ID}:${THREAD_ID}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
  };
}

async function renderReply(entries: ReadonlyArray<Entry> = [entry(REPLY)]) {
  const container = document.createElement("div");
  container.style.cssText = "height: 800px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(
    <MessagesTimeline {...timelineProps()} timelineEntries={entries as Entry[]} />,
    { container },
  );
  const buttons = (label: string) =>
    [...container.querySelectorAll<HTMLElement>("button")].filter(
      (button) => button.getAttribute("aria-label") === label,
    );
  return Object.assign(screen, { buttons });
}

const commands = () => ({ [Symbol.dispose]: installReadAloudCommands(router) });
const readAloudChord = () => userEvent.keyboard("{Control>}{Alt>}r{/Alt}{/Control}");

it("control: with no Hearsay URL there is no button and the key does nothing", async () => {
  setup("");
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  using _commands = commands();
  await using screen = await renderReply();
  await expect.element(screen.getByLabelText("Copy message")).toBeInTheDocument();
  expect(screen.buttons("Read aloud")).toHaveLength(0);
  await readAloudChord();
  await userEvent.keyboard("{Escape}");
  expect(state.calls).toEqual([]);
  expect(readReadAloudState()).toEqual({ state: "idle" });
  expect(FakeAudioContext.instances).toHaveLength(0);
});

it("the button speaks its reply, becomes the stop button, and stops", async () => {
  setup("http://127.0.0.1:47700");
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  await using screen = await renderReply();
  expect(screen.buttons("Stop reading")).toHaveLength(0);
  const [button] = screen.buttons("Read aloud");
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await vi.waitFor(() => expect(readReadAloudState().state).toBe("playing"));
  expect(state.calls).toEqual([
    { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID, messageId: REPLY },
  ]);
  await expect.element(screen.getByLabelText("Stop reading")).toBeInTheDocument();
  expect(screen.buttons("Read aloud")).toHaveLength(0);
  // Four bytes became two samples in one buffer; the odd byte waits for the next chunk.
  const context = FakeAudioContext.instances[0]!;
  expect(context.sources).toHaveLength(1);
  expect(context.sources[0]!.buffer?.length).toBe(2);
  await act(async () => screen.buttons("Stop reading")[0]!.click());
  expect(readReadAloudState()).toEqual({ state: "idle" });
  expect(context.closed).toBe(true);
  await expect.element(screen.getByLabelText("Read aloud")).toBeInTheDocument();
  await state.stops[0];
});

it("playback ends on its own once the last buffer has played", async () => {
  setup("http://127.0.0.1:47700");
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  await using screen = await renderReply();
  await act(async () => screen.buttons("Read aloud")[0]!.click());
  await vi.waitFor(() => expect(readReadAloudState().state).toBe("playing"));
  const context = FakeAudioContext.instances[0]!;
  await act(async () => context.endAll());
  await vi.waitFor(() => expect(readReadAloudState()).toEqual({ state: "idle" }));
  expect(context.closed).toBe(true);
});

it("a streaming reply has no button", async () => {
  setup("http://127.0.0.1:47700");
  await using screen = await renderReply([entry(REPLY, "Still writing", true)]);
  expect(screen.buttons("Read aloud")).toHaveLength(0);
});

it("the key reads the last finished reply of the open thread and Escape stops it", async () => {
  setup("http://127.0.0.1:47700");
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  using _commands = commands();
  await using _screen = await renderReply();
  await readAloudChord();
  await vi.waitFor(() => expect(readReadAloudState().state).toBe("playing"));
  // The later reply is still streaming, so the finished one before it is read.
  expect(state.calls.map((call) => call.messageId)).toEqual([REPLY]);
  await userEvent.keyboard("{Escape}");
  expect(readReadAloudState()).toEqual({ state: "idle" });
  await readAloudChord();
  await vi.waitFor(() => expect(readReadAloudState().state).toBe("playing"));
  await readAloudChord();
  expect(readReadAloudState()).toEqual({ state: "idle" });
  expect(state.calls).toHaveLength(2);
});

it("opening the microphone stops reading", async () => {
  setup("http://127.0.0.1:47700");
  using _audio = stubGlobal("AudioContext", FakeAudioContext);
  const opened: MediaStreamConstraints[] = [];
  // The fork wraps the instance's property and calls through to the prototype's method.
  const prototype = Object.getPrototypeOf(navigator.mediaDevices) as MediaDevices;
  const original = prototype.getUserMedia;
  prototype.getUserMedia = (constraints) => {
    opened.push(constraints ?? {});
    return Promise.resolve({} as MediaStream);
  };
  try {
    using _commands = commands();
    await using screen = await renderReply();
    await act(async () => screen.buttons("Read aloud")[0]!.click());
    await vi.waitFor(() => expect(readReadAloudState().state).toBe("playing"));
    await navigator.mediaDevices.getUserMedia({ audio: true });
    expect(opened).toEqual([{ audio: true }]);
    expect(readReadAloudState()).toEqual({ state: "idle" });
  } finally {
    prototype.getUserMedia = original;
  }
});
