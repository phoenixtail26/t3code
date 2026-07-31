// @effect-diagnostics nodeBuiltinImport:off
// Raw node:fs is deliberate: the loader reads real session files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ExternalTranscriptEntry } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { encodeProjectSlug } from "../externalSessions/projectSlug.ts";
import { cutInheritedEntries, loadInheritedEntries } from "./inheritedTranscript.ts";

const userEntry = (id: string, text: string, createdAt: string): ExternalTranscriptEntry => ({
  kind: "message",
  id,
  role: "user",
  text,
  createdAt,
  turnId: id,
});

const assistantEntry = (id: string, text: string, createdAt: string): ExternalTranscriptEntry => ({
  kind: "message",
  id,
  role: "assistant",
  text,
  createdAt,
  turnId: null,
});

describe("cutInheritedEntries", () => {
  const entries = [
    userEntry("u1", "explain the config", "2026-07-18T09:00:00.000Z"),
    assistantEntry("a1", "it does things", "2026-07-18T09:00:05.000Z"),
    userEntry("u2", "continue", "2026-07-18T09:01:00.000Z"),
    assistantEntry("a2", "more things", "2026-07-18T09:01:05.000Z"),
    userEntry("u3", "continue", "2026-07-18T10:00:00.000Z"),
  ];

  it("keeps everything when the thread has no turns yet", () => {
    assert.strictEqual(cutInheritedEntries(entries, null).length, entries.length);
  });

  it("cuts strictly before the thread's first own message", () => {
    const cut = cutInheritedEntries(entries, {
      text: "continue",
      createdAt: "2026-07-18T10:00:01.000Z",
    });
    // Two "continue" candidates — the one closest in time (u3) wins, so the
    // inherited slice keeps the earlier duplicated prompt.
    assert.deepStrictEqual(
      cut.map((entry) => entry.id),
      ["u1", "a1", "u2", "a2"],
    );
  });

  it("prefers the closest timestamp among duplicate texts", () => {
    const cut = cutInheritedEntries(entries, {
      text: "continue",
      createdAt: "2026-07-18T09:01:01.000Z",
    });
    assert.deepStrictEqual(
      cut.map((entry) => entry.id),
      ["u1", "a1"],
    );
  });

  it("returns nothing when the transcript cannot be aligned", () => {
    const cut = cutInheritedEntries(entries, {
      text: "totally different message",
      createdAt: "2026-07-18T10:00:00.000Z",
    });
    assert.strictEqual(cut.length, 0);
  });

  it("matches on trimmed text", () => {
    const cut = cutInheritedEntries(entries, {
      text: "  explain the config  ",
      createdAt: "2026-07-18T09:00:00.000Z",
    });
    assert.strictEqual(cut.length, 0);
  });
});

describe("loadInheritedEntries", () => {
  const FIXTURE = NodePath.join(
    import.meta.dirname,
    "..",
    "externalSessions",
    "__fixtures__",
    "short-session.jsonl",
  );
  const SESSION_ID = "ae214dc4-2886-4e93-9bbf-47abcfde2db7";
  const FIXTURE_CWD = "C:\\fake\\project";

  const makeRoot = () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-inherited-test-"));
    const slugDir = NodePath.join(root, encodeProjectSlug(FIXTURE_CWD));
    NodeFS.mkdirSync(slugDir, { recursive: true });
    NodeFS.copyFileSync(FIXTURE, NodePath.join(slugDir, `${SESSION_ID}.jsonl`));
    return root;
  };

  it.effect("returns the whole transcript for a thread with no turns yet", () =>
    Effect.gen(function* () {
      const { entries, truncated } = yield* loadInheritedEntries({
        threadId: ThreadId.make("thread-1"),
        sessionId: SESSION_ID,
        preferredCwd: FIXTURE_CWD,
        firstOwnMessage: null,
        sessionsRootOverride: makeRoot(),
      });
      assert.ok(entries.length >= 2, "fixture has a user and an assistant message");
      assert.strictEqual(truncated, false);
      const first = entries.find((entry) => entry.kind === "message");
      assert.ok(first && first.kind === "message" && first.role === "user");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns an empty slice for an ordinary thread (boundary is its first message)", () =>
    Effect.gen(function* () {
      const { entries } = yield* loadInheritedEntries({
        threadId: ThreadId.make("thread-1"),
        sessionId: SESSION_ID,
        preferredCwd: FIXTURE_CWD,
        firstOwnMessage: {
          text: "What does the parseConfig function do?",
          createdAt: "2026-07-18T09:15:03.100Z",
        },
        sessionsRootOverride: makeRoot(),
      });
      assert.strictEqual(entries.length, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("finds the session under another slug when the preferred cwd misses", () =>
    Effect.gen(function* () {
      const { entries } = yield* loadInheritedEntries({
        threadId: ThreadId.make("thread-1"),
        sessionId: SESSION_ID,
        preferredCwd: "D:\\somewhere\\else",
        firstOwnMessage: null,
        sessionsRootOverride: makeRoot(),
      });
      assert.ok(entries.length >= 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("soft-fails to an empty slice when the session file is missing", () =>
    Effect.gen(function* () {
      const { entries, truncated } = yield* loadInheritedEntries({
        threadId: ThreadId.make("thread-1"),
        sessionId: "00000000-0000-4000-8000-00000000dead",
        preferredCwd: FIXTURE_CWD,
        firstOwnMessage: null,
        sessionsRootOverride: makeRoot(),
      });
      assert.strictEqual(entries.length, 0);
      assert.strictEqual(truncated, false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
