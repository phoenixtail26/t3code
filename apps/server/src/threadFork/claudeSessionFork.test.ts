// @effect-diagnostics nodeBuiltinImport:off
// Integration test against the real SDK forkSession over a temp
// CLAUDE_CONFIG_DIR (raw node:fs is deliberate: the SDK itself works on the
// real filesystem). The env var must be set before the first SDK call in
// this process (the SDK memoizes config-dir resolution at call time), which
// is why every test funnels through ensureTempClaudeHome.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { forkClaudeSession } from "./claudeSessionFork.ts";

const FIXTURE = NodePath.join(
  import.meta.dirname,
  "..",
  "externalSessions",
  "__fixtures__",
  "short-session.jsonl",
);
const SOURCE_SESSION_ID = "ae214dc4-2886-4e93-9bbf-47abcfde2db7";
const FIRST_USER_MESSAGE_ID = "295be05d-4996-4b9f-ac28-2c70fae7a690";

let sharedHome: string | undefined;

/** One temp home per test process — CLAUDE_CONFIG_DIR is read once by the SDK. */
function ensureTempClaudeHome(): { home: string; projectDir: string } {
  if (sharedHome === undefined) {
    sharedHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-test-"));
    process.env["CLAUDE_CONFIG_DIR"] = sharedHome;
  }
  const projectDir = NodePath.join(sharedHome, "projects", "C--fake-project");
  NodeFS.mkdirSync(projectDir, { recursive: true });
  const sessionFile = NodePath.join(projectDir, `${SOURCE_SESSION_ID}.jsonl`);
  if (!NodeFS.existsSync(sessionFile)) {
    NodeFS.copyFileSync(FIXTURE, sessionFile);
  }
  return { home: sharedHome, projectDir };
}

function readSessionIds(projectDir: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(projectDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.replace(/\.jsonl$/, ""));
}

it.effect("forks a session into a new file without touching the source", () =>
  Effect.gen(function* () {
    const { projectDir } = ensureTempClaudeHome();
    const sourceBefore = NodeFS.readFileSync(
      NodePath.join(projectDir, `${SOURCE_SESSION_ID}.jsonl`),
      "utf8",
    );

    const { sessionId } = yield* forkClaudeSession({ sourceSessionId: SOURCE_SESSION_ID });

    assert.notStrictEqual(sessionId, SOURCE_SESSION_ID);
    assert.ok(readSessionIds(projectDir).includes(sessionId), "forked file should exist");

    const forked = NodeFS.readFileSync(NodePath.join(projectDir, `${sessionId}.jsonl`), "utf8");
    const forkedRecords = forked
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { sessionId?: string; uuid?: string });
    assert.ok(forkedRecords.length > 0);
    for (const record of forkedRecords) {
      if (record.sessionId !== undefined) {
        assert.strictEqual(record.sessionId, sessionId, "records must carry the new session id");
      }
      assert.notStrictEqual(record.uuid, FIRST_USER_MESSAGE_ID, "uuids must be remapped");
    }

    const sourceAfter = NodeFS.readFileSync(
      NodePath.join(projectDir, `${SOURCE_SESSION_ID}.jsonl`),
      "utf8",
    );
    assert.strictEqual(sourceAfter, sourceBefore, "source session file must be unchanged");
  }),
);

it.effect("slices the transcript when upToMessageId is given", () =>
  Effect.gen(function* () {
    const { projectDir } = ensureTempClaudeHome();

    const full = yield* forkClaudeSession({ sourceSessionId: SOURCE_SESSION_ID });
    const sliced = yield* forkClaudeSession({
      sourceSessionId: SOURCE_SESSION_ID,
      upToMessageId: FIRST_USER_MESSAGE_ID,
    });

    const countChainRecords = (sessionId: string) =>
      NodeFS.readFileSync(NodePath.join(projectDir, `${sessionId}.jsonl`), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { uuid?: string })
        .filter((record) => record.uuid !== undefined).length;

    assert.ok(
      countChainRecords(sliced.sessionId) < countChainRecords(full.sessionId),
      "slice up to the first user message must drop later chain records",
    );
  }),
);

it.effect("fails with ClaudeSessionForkError for an unknown session", () =>
  Effect.gen(function* () {
    ensureTempClaudeHome();
    const error = yield* Effect.flip(
      forkClaudeSession({ sourceSessionId: "00000000-0000-4000-8000-00000000dead" }),
    );
    assert.strictEqual(error._tag, "ClaudeSessionForkError");
    assert.match(error.detail, /not found/i);
  }),
);
