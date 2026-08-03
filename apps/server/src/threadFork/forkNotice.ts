// @effect-diagnostics preferSchemaOverJson:off -- reads/writes raw CLI JSONL
// records whose shape is the CLI's, not ours; a schema here would imply a
// contract we don't own.
// Fork feature: fork-notice injection (FORK_PLAN_FORKING.md). A forked or
// adopted session's context ends mid-whatever the source was doing, so the
// model resumes that work on its first turn — the "two threads doing the
// same task" failure. The CLI's own mechanism for invisible context is an
// `isMeta` user record: the model sees it, every transcript renderer drops
// it (transcriptView.ts:293 skips isMeta). We append one to the forked copy
// telling the model the in-flight work stays with the source.
//
// Hand-writing a transcript record couples us to the CLI's format; the
// record mirrors a real capture (see forkNotice.test.ts) and the CLI parses
// leniently, so a drifted format degrades to the record being ignored —
// i.e. today's behavior, not a broken session.
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { locateSessionFile, readTranscriptFileCapped } from "./inheritedTranscript.ts";

export const FORK_NOTICE_TEXT =
  "<system-reminder>This session was forked from another conversation. " +
  "Any task that was in progress above belongs to the original session — do " +
  "not resume or continue it unless explicitly asked. Treat the next user " +
  "message as a fresh request, using the conversation above only as " +
  "context.</system-reminder>";

export const ADOPT_NOTICE_TEXT =
  "<system-reminder>This session was adopted from a Claude Code CLI session " +
  "into t3code. Any task that was in progress above belongs to the original " +
  "CLI session — do not resume or continue it unless explicitly asked. Treat " +
  "the next user message as a fresh request, using the conversation above " +
  "only as context.</system-reminder>";

/** Last `uuid` in the file's message chain, so the notice chains onto it. */
function lastChainUuid(text: string): string | null {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line) as { uuid?: unknown };
      if (typeof record.uuid === "string" && record.uuid.length > 0) return record.uuid;
    } catch {
      // Partial/foreign line — keep walking up.
    }
  }
  return null;
}

/**
 * Append an `isMeta` notice record to a freshly forked session file.
 * Best-effort: callers treat failure as "no notice", never as a failed fork.
 */
export const appendForkNotice = Effect.fn("threadFork.appendForkNotice")(function* (input: {
  readonly sessionId: string;
  readonly preferredCwd: string | null;
  readonly noticeText: string;
  /** Test seam; production uses the default Claude config dir. */
  readonly sessionsRootOverride?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;

  const filePath = yield* locateSessionFile(
    input.sessionId,
    input.preferredCwd,
    input.sessionsRootOverride,
  );
  if (filePath === undefined) return false;
  const { text } = yield* readTranscriptFileCapped(filePath);
  const parentUuid = lastChainUuid(text);
  if (parentUuid === null) return false;

  // Field set mirrors a real CLI isMeta capture; optional CLI fields
  // (version, gitBranch, promptId) are omitted — records from older CLI
  // versions lack them too, so readers tolerate their absence.
  const record = {
    parentUuid,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: [{ type: "text", text: input.noticeText }] },
    isMeta: true,
    uuid: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
    timestamp: DateTime.formatIso(yield* DateTime.now),
    userType: "external",
    sessionId: input.sessionId,
    ...(input.preferredCwd !== null ? { cwd: input.preferredCwd } : {}),
  };

  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(filePath, { flag: "a" });
      yield* file.write(new TextEncoder().encode(`${JSON.stringify(record)}\n`));
    }),
  );
  return true;
});
