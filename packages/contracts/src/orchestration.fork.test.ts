// Fork-owned tests for the fork/adopt additions to the orchestration
// contracts (resumeCursor + forkedFromThreadId on thread.create /
// thread.created). Kept out of orchestration.test.ts so upstream syncs never
// conflict here.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OrchestrationCommand, OrchestrationEvent, ThreadCreatedPayload } from "./orchestration.ts";

const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const encodeThreadCreatedPayload = Schema.encodeEffect(ThreadCreatedPayload);

const baseCreateCommand = {
  type: "thread.create",
  commandId: "cmd-create-1",
  threadId: "thread-1",
  projectId: "project-1",
  title: "Forked thread",
  modelSelection: {
    provider: "claudeAgent",
    model: "claude-opus-4-6",
  },
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const baseCreatedPayload = {
  threadId: "thread-1",
  projectId: "project-1",
  title: "Forked thread",
  modelSelection: {
    provider: "claudeAgent",
    model: "claude-opus-4-6",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const claudeCursor = {
  threadId: "thread-1",
  resume: "3f6c9a52-0000-4000-8000-000000000000",
  turnCount: 0,
};

it.effect("decodes thread.create carrying a seeded resume cursor verbatim", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      ...baseCreateCommand,
      resumeCursor: claudeCursor,
      forkedFromThreadId: "thread-source",
    });
    assert.strictEqual(parsed.type, "thread.create");
    if (parsed.type === "thread.create") {
      assert.deepStrictEqual(parsed.resumeCursor, claudeCursor);
      assert.strictEqual(parsed.forkedFromThreadId, "thread-source");
    }
  }),
);

it.effect("decodes thread.create without the fork fields (pre-field clients)", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand(baseCreateCommand);
    assert.strictEqual(parsed.type, "thread.create");
    if (parsed.type === "thread.create") {
      assert.ok(!("resumeCursor" in parsed) || parsed.resumeCursor === undefined);
      assert.ok(!("forkedFromThreadId" in parsed) || parsed.forkedFromThreadId === undefined);
    }
  }),
);

it.effect("decodes pre-field stored thread.created events (decode compat)", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-create-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.created",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-create-1",
      causationEventId: null,
      correlationId: "cmd-create-1",
      metadata: {},
      payload: baseCreatedPayload,
    });
    if (parsed.type !== "thread.created") {
      assert.fail(`Expected thread.created event, received ${parsed.type}.`);
    }
    assert.strictEqual(parsed.payload.threadId, "thread-1");
    assert.ok(!("resumeCursor" in parsed.payload) || parsed.payload.resumeCursor === undefined);
  }),
);

it.effect("decodes thread.created events carrying the fork fields", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-create-2",
      aggregateKind: "thread",
      aggregateId: "thread-2",
      type: "thread.created",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-create-2",
      causationEventId: null,
      correlationId: "cmd-create-2",
      metadata: {},
      payload: {
        ...baseCreatedPayload,
        threadId: "thread-2",
        resumeCursor: claudeCursor,
        forkedFromThreadId: "thread-1",
      },
    });
    if (parsed.type !== "thread.created") {
      assert.fail(`Expected thread.created event, received ${parsed.type}.`);
    }
    assert.deepStrictEqual(parsed.payload.resumeCursor, claudeCursor);
    assert.strictEqual(parsed.payload.forkedFromThreadId, "thread-1");
  }),
);

it.effect("encoding omits the fork keys entirely when absent", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeThreadCreatedPayload(baseCreatedPayload);
    const encoded = yield* encodeThreadCreatedPayload(decoded);
    assert.ok(!("resumeCursor" in encoded));
    assert.ok(!("forkedFromThreadId" in encoded));
  }),
);

it.effect("round-trips the resume cursor through encode/decode unchanged", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeThreadCreatedPayload({
      ...baseCreatedPayload,
      resumeCursor: claudeCursor,
      forkedFromThreadId: "thread-1",
    });
    const encoded = yield* encodeThreadCreatedPayload(decoded);
    assert.deepStrictEqual(encoded.resumeCursor, claudeCursor);
    assert.strictEqual(encoded.forkedFromThreadId, "thread-1");
    const redecoded = yield* decodeThreadCreatedPayload(encoded);
    assert.deepStrictEqual(redecoded.resumeCursor, claudeCursor);
  }),
);
