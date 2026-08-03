// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
// Raw node:fs and JSON.parse are deliberate: the notice is appended to real
// session files whose record shape is the CLI's, not ours.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { encodeProjectSlug } from "../externalSessions/projectSlug.ts";
import { mapTranscriptContent } from "../externalSessions/transcriptView.ts";
import { appendForkNotice, FORK_NOTICE_TEXT } from "./forkNotice.ts";

const FIXTURE = NodePath.join(
  import.meta.dirname,
  "..",
  "externalSessions",
  "__fixtures__",
  "short-session.jsonl",
);
const SESSION_ID = "ae214dc4-2886-4e93-9bbf-47abcfde2db7";
const FIXTURE_CWD = "C:\\fake\\project";
// The fixture's last chain record (the closing `system` message).
const FIXTURE_LAST_CHAIN_UUID = "ec91ed23-97c3-40e5-b6a6-682a4644adbc";

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);
const testLayer = Layer.mergeAll(NodeServices.layer, cryptoLayer);

const makeRoot = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-notice-test-"));
  const slugDir = NodePath.join(root, encodeProjectSlug(FIXTURE_CWD));
  NodeFS.mkdirSync(slugDir, { recursive: true });
  const filePath = NodePath.join(slugDir, `${SESSION_ID}.jsonl`);
  NodeFS.copyFileSync(FIXTURE, filePath);
  return { root, filePath };
};

describe("appendForkNotice", () => {
  it.effect("appends an isMeta record chained onto the last message", () =>
    Effect.gen(function* () {
      const { root, filePath } = makeRoot();
      const appended = yield* appendForkNotice({
        sessionId: SESSION_ID,
        preferredCwd: FIXTURE_CWD,
        noticeText: FORK_NOTICE_TEXT,
        sessionsRootOverride: root,
      });
      assert.strictEqual(appended, true);

      const lines = NodeFS.readFileSync(filePath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      const record = JSON.parse(lines[lines.length - 1] ?? "{}") as {
        type?: string;
        isMeta?: boolean;
        isSidechain?: boolean;
        parentUuid?: string;
        uuid?: string;
        sessionId?: string;
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      assert.strictEqual(record.type, "user");
      assert.strictEqual(record.isMeta, true);
      assert.strictEqual(record.isSidechain, false);
      assert.strictEqual(record.parentUuid, FIXTURE_LAST_CHAIN_UUID);
      assert.strictEqual(record.sessionId, SESSION_ID);
      assert.ok(record.uuid && record.uuid.length > 0);
      assert.strictEqual(record.message?.content?.[0]?.text, FORK_NOTICE_TEXT);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("the appended notice never renders in transcript views", () =>
    Effect.gen(function* () {
      const { root, filePath } = makeRoot();
      yield* appendForkNotice({
        sessionId: SESSION_ID,
        preferredCwd: FIXTURE_CWD,
        noticeText: FORK_NOTICE_TEXT,
        sessionsRootOverride: root,
      });
      const { entries } = mapTranscriptContent(NodeFS.readFileSync(filePath, "utf8"));
      const noticeVisible = entries.some(
        (entry) => entry.kind === "message" && entry.text.includes("system-reminder"),
      );
      assert.strictEqual(noticeVisible, false);
      assert.ok(entries.length >= 2, "the real conversation still renders");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports false for an unknown session instead of failing", () =>
    Effect.gen(function* () {
      const { root } = makeRoot();
      const appended = yield* appendForkNotice({
        sessionId: "00000000-0000-4000-8000-00000000dead",
        preferredCwd: FIXTURE_CWD,
        noticeText: FORK_NOTICE_TEXT,
        sessionsRootOverride: root,
      });
      assert.strictEqual(appended, false);
    }).pipe(Effect.provide(testLayer)),
  );
});
