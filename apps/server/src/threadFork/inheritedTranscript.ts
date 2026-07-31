// @effect-diagnostics nodeBuiltinImport:off
// (Pure path joins over paths produced by claudeSessionsRoot.ts, which has
// the same exemption.)
// Fork feature: inherited-history prelude (FORK_PLAN_FORKING.md). A forked
// or adopted thread's Claude session file carries conversation that predates
// the thread's own event history; this module maps that slice with the
// radar's transcript mapper so the client can show it read-only.
//
// The boundary needs no stored provenance: the thread's own first user
// message necessarily appears in the session transcript, so everything
// before it is inherited. For an ordinary thread the first user entry IS its
// own first message, and the inherited slice is empty. Every soft failure
// (no binding, file gone, no boundary match) degrades to an empty slice —
// the prelude is best-effort, never an error surface.
import * as NodePath from "node:path";

import type { ExternalTranscriptEntry, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { resolveClaudeSessionsRoot } from "../externalSessions/claudeSessionsRoot.ts";
import { encodeProjectSlug } from "../externalSessions/projectSlug.ts";
import {
  mapTranscriptContent,
  MAX_TRANSCRIPT_READ_BYTES,
} from "../externalSessions/transcriptView.ts";

const textDecoder = new TextDecoder();

/**
 * Cut a mapped transcript at the thread's own first user message. Returns
 * everything strictly before it — the inherited slice.
 *
 * `firstOwnMessage === null` (no turns yet) keeps the whole transcript.
 * Text matches on trimmed equality; among duplicate texts the entry whose
 * timestamp is closest to the own message's wins (inherited copies of a
 * repeated prompt predate the fork, the own one doesn't). No match at all
 * means the transcript can't be aligned — return nothing rather than risk
 * duplicating rows the timeline already shows.
 */
export function cutInheritedEntries(
  entries: ReadonlyArray<ExternalTranscriptEntry>,
  firstOwnMessage: { readonly text: string; readonly createdAt: string } | null,
): ReadonlyArray<ExternalTranscriptEntry> {
  if (firstOwnMessage === null) return entries;
  const targetText = firstOwnMessage.text.trim();
  const targetAt = Date.parse(firstOwnMessage.createdAt);
  let boundaryIndex = -1;
  let boundaryDistance = Number.POSITIVE_INFINITY;
  for (const [index, entry] of entries.entries()) {
    if (entry.kind !== "message" || entry.role !== "user") continue;
    if (entry.text.trim() !== targetText) continue;
    const distance = Number.isNaN(targetAt) ? 0 : Math.abs(Date.parse(entry.createdAt) - targetAt);
    if (distance < boundaryDistance) {
      boundaryDistance = distance;
      boundaryIndex = index;
    }
  }
  if (boundaryIndex === -1) return [];
  return entries.slice(0, boundaryIndex);
}

/**
 * Find `<sessionId>.jsonl` under the default Claude config dir: the slug for
 * `preferredCwd` first (the thread's working directory), then a sweep of the
 * other project-slug directories (a session can live under a different slug
 * than the thread's current cwd).
 */
export const locateSessionFile = Effect.fn("threadFork.locateSessionFile")(function* (
  sessionId: string,
  preferredCwd: string | null,
  rootOverride?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = rootOverride ?? resolveClaudeSessionsRoot("");
  const fileName = `${sessionId}.jsonl`;

  if (preferredCwd !== null) {
    const preferred = NodePath.join(root, encodeProjectSlug(preferredCwd), fileName);
    if (yield* fs.exists(preferred).pipe(Effect.orElseSucceed(() => false))) {
      return preferred;
    }
  }
  const slugs = yield* fs
    .readDirectory(root)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  for (const slug of slugs) {
    const candidate = NodePath.join(root, slug, fileName);
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return candidate;
    }
  }
  return undefined;
});

/** Same capped tail-read as the radar's transcript RPC (drop the leading
 * partial line when the byte cap trips). */
export const readTranscriptFileCapped = Effect.fn("threadFork.readTranscriptFileCapped")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(filePath);
  const size = Number(info.size);
  if (size <= MAX_TRANSCRIPT_READ_BYTES) {
    const text = yield* fs.readFileString(filePath);
    return { text, byteCapTripped: false };
  }
  const start = size - MAX_TRANSCRIPT_READ_BYTES;
  const bytes = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(filePath);
      if (start > 0) yield* file.seek(start, "start");
      const read = yield* file.readAlloc(size - start);
      return Option.getOrElse(read, () => new Uint8Array(0));
    }),
  );
  const raw = textDecoder.decode(bytes);
  const firstNewline = raw.indexOf("\n");
  const text = firstNewline === -1 ? "" : raw.slice(firstNewline + 1);
  return { text, byteCapTripped: true };
});

/** Map a session file to its inherited slice for a thread. Soft-fails to an
 * empty slice; `truncated` reports the byte/entry caps. */
export const loadInheritedEntries = Effect.fn("threadFork.loadInheritedEntries")(function* (input: {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly preferredCwd: string | null;
  readonly firstOwnMessage: { readonly text: string; readonly createdAt: string } | null;
  /** Test seam; production uses the default Claude config dir (radar stance). */
  readonly sessionsRootOverride?: string;
}) {
  const filePath = yield* locateSessionFile(
    input.sessionId,
    input.preferredCwd,
    input.sessionsRootOverride,
  );
  if (filePath === undefined) {
    return { entries: [] as ReadonlyArray<ExternalTranscriptEntry>, truncated: false };
  }
  const read = yield* readTranscriptFileCapped(filePath).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (read === undefined) {
    return { entries: [] as ReadonlyArray<ExternalTranscriptEntry>, truncated: false };
  }
  const { entries, entryCapTripped } = mapTranscriptContent(read.text);
  return {
    entries: cutInheritedEntries(entries, input.firstOwnMessage),
    truncated: read.byteCapTripped || entryCapTripped,
  };
});
