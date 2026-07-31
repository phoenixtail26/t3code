import {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { seedThreadSessionBinding } from "./sessionSeed.ts";

const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);

const claudeInstanceId = ProviderInstanceId.make("claudeAgent");

const providerServiceMock = Layer.mock(ProviderService, {
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
});

const testLayer = Layer.mergeAll(
  ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntime.layer),
    Layer.provide(SqlitePersistenceMemory),
  ),
  providerServiceMock,
);

const claudeCursor = {
  threadId: "thread-fork-1",
  resume: "3f6c9a52-0000-4000-8000-000000000000",
  turnCount: 0,
};

it.effect("persists the seeded cursor as a stopped binding readable by startSession", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-fork-1");
    yield* seedThreadSessionBinding({
      threadId,
      modelSelection: decodeModelSelection({
        instanceId: "claudeAgent",
        model: "claude-opus-4-6",
      }),
      resumeCursor: claudeCursor,
    });

    const directory = yield* ProviderSessionDirectory;
    const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
    assert.ok(binding, "expected a persisted binding for the seeded thread");
    assert.strictEqual(binding.provider, "claudeAgent");
    // startSession only uses the persisted cursor when the binding's
    // instance id matches the instance the turn starts with — pin both.
    assert.strictEqual(binding.providerInstanceId, claudeInstanceId);
    assert.strictEqual(binding.status, "stopped");
    assert.deepStrictEqual(binding.resumeCursor, claudeCursor);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("overwrites a re-seed for the same thread rather than duplicating", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-fork-2");
    const modelSelection = decodeModelSelection({
      instanceId: "claudeAgent",
      model: "claude-opus-4-6",
    });
    yield* seedThreadSessionBinding({
      threadId,
      modelSelection,
      resumeCursor: { ...claudeCursor, resume: "first" },
    });
    yield* seedThreadSessionBinding({
      threadId,
      modelSelection,
      resumeCursor: { ...claudeCursor, resume: "second" },
    });

    const directory = yield* ProviderSessionDirectory;
    const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
    assert.ok(binding);
    assert.deepStrictEqual(binding.resumeCursor, { ...claudeCursor, resume: "second" });
  }).pipe(Effect.provide(testLayer)),
);
