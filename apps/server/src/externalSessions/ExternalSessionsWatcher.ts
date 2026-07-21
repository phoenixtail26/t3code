/**
 * ExternalSessionsWatcher — discovers Claude Code sessions on this machine
 * (fork feature: "the radar"; see DESIGN.md in this directory and
 * FORK_PLAN_RADAR.md at the repo root).
 *
 * Watches `<claude-config>/projects/<slug>/*.jsonl` for directories whose
 * slug corresponds to a workspace root t3code knows about, tails appended
 * bytes through the lenient parser, and exposes a snapshot plus change
 * stream of external session state.
 *
 * Follows the `serverSettings.ts` / `keybindings.ts` watcher-service
 * pattern: Context.Service + PubSub + dedicated watcher Scope closed by a
 * layer finalizer + idempotent `start`.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveClaudeSessionsRoot } from "./claudeSessionsRoot.ts";
import { encodeProjectSlug } from "./projectSlug.ts";
import {
  deriveExternalSessionState,
  emptyMetadata,
  type ExternalSessionMetadata,
  foldRecord,
  resolveTitle,
} from "./sessionMetadata.ts";
import { parseTranscriptLine, splitJsonlChunk } from "./transcriptRecords.ts";

export type ExternalSessionState = "working" | "idle" | "waiting";

export interface ExternalSessionSnapshot {
  readonly sessionId: string;
  readonly projectSlug: string;
  readonly filePath: string;
  readonly cwd: string | null;
  readonly title: string | null;
  readonly state: ExternalSessionState;
  readonly lastActivityAt: string;
}

export type ExternalSessionsEvent =
  | { readonly kind: "upsert"; readonly session: ExternalSessionSnapshot }
  | { readonly kind: "removed"; readonly sessionId: string };

/** Initial scan reads only the head and tail of a file, never the middle —
 * transcripts reach tens of MB and titles restate near the tail anyway. */
const HEAD_SCAN_BYTES = 64 * 1024;
const TAIL_SCAN_BYTES = 64 * 1024;
/** A single watch-event read is capped; a bigger delta skips ahead. */
const MAX_TAIL_READ_BYTES = 256 * 1024;
/** Hard cap on watched project dirs — the radar is best-effort, not exhaustive. */
const MAX_WATCHED_DIRS = 64;
/** Time-derived state transitions (`working`→`idle`, dangling tool_use
 * →`waiting`) happen without an FS event; re-derive on a tick. */
const STATE_DECAY_TICK_MS = 30_000;
/** Sessions idle longer than this are ignored entirely — the radar is for
 * current work, not history (long-lived projects accumulate hundreds of
 * transcripts). Any new activity on an old session (a single appended line)
 * brings it back within one dir event. */
const MAX_SESSION_AGE_MS = 2 * 24 * 60 * 60 * 1000;

const textDecoder = new TextDecoder();

interface FileTailState {
  readonly sessionId: string;
  readonly projectSlug: string;
  readonly filePath: string;
  offset: number;
  carry: string;
  meta: ExternalSessionMetadata;
  mtimeMs: number;
}

export class ExternalSessionsWatcher extends Context.Service<
  ExternalSessionsWatcher,
  {
    /** Start the sessions-root watcher and the state-decay tick. Idempotent. */
    readonly start: Effect.Effect<void>;

    /** Register workspace roots whose slug-dirs should be watched. Additive;
     * dirs are never unwatched until server restart. Never fails. */
    readonly ensureRoots: (roots: ReadonlyArray<string>) => Effect.Effect<void>;

    /** Current view of all discovered external sessions. */
    readonly snapshot: Effect.Effect<ReadonlyArray<ExternalSessionSnapshot>>;

    /** Live change events (full per-session snapshots + removals). */
    readonly changes: Stream.Stream<ExternalSessionsEvent>;
  }
>()("t3/externalSessions/ExternalSessionsWatcher") {}

const snapshotEquals = (a: ExternalSessionSnapshot, b: ExternalSessionSnapshot): boolean =>
  a.sessionId === b.sessionId &&
  a.projectSlug === b.projectSlug &&
  a.filePath === b.filePath &&
  a.cwd === b.cwd &&
  a.title === b.title &&
  a.state === b.state &&
  a.lastActivityAt === b.lastActivityAt;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const mutex = yield* Semaphore.make(1);
  const eventsPubSub = yield* PubSub.unbounded<ExternalSessionsEvent>();
  const startedRef = yield* Ref.make(false);
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  // Matches the usage-meter precedent (claudeUsage.ts): only the default
  // config dir is consulted; custom homePath instances are not plumbed
  // through yet (DESIGN.md, "Source of truth on disk").
  const sessionsRoot = resolveClaudeSessionsRoot("");

  // `sessions` and `tails` are only mutated while holding `mutex`. The two
  // slug sets are mutated with synchronous check-then-add (no yield between
  // check and add), which is race-free under fiber interleaving.
  const sessions = new Map<string, ExternalSessionSnapshot>();
  const tails = new Map<string, FileTailState>();
  const watchedSlugs = new Set<string>();
  const candidateSlugs = new Set<string>();

  const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);

  const readRange = Effect.fn("ExternalSessionsWatcher.readRange")(function* (
    filePath: string,
    start: number,
    end: number,
  ) {
    if (end <= start) return new Uint8Array(0);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(filePath);
        if (start > 0) yield* file.seek(start, "start");
        const read = yield* file.readAlloc(end - start);
        return Option.getOrElse(read, () => new Uint8Array(0));
      }),
    );
  });

  const snapshotOf = (tail: FileTailState, nowMs: number): ExternalSessionSnapshot => ({
    sessionId: tail.sessionId,
    projectSlug: tail.projectSlug,
    filePath: tail.filePath,
    cwd: tail.meta.cwd,
    title: resolveTitle(tail.meta),
    state: deriveExternalSessionState(nowMs, tail.mtimeMs, tail.meta),
    lastActivityAt: DateTime.formatIso(DateTime.makeUnsafe(tail.mtimeMs)),
  });

  const applyUpsert = (next: ExternalSessionSnapshot) =>
    Effect.gen(function* () {
      const prev = sessions.get(next.sessionId);
      if (prev !== undefined && snapshotEquals(prev, next)) return;
      sessions.set(next.sessionId, next);
      yield* PubSub.publish(eventsPubSub, { kind: "upsert", session: next });
    }).pipe(Effect.asVoid);

  const foldLines = (tail: FileTailState, lines: ReadonlyArray<string>): void => {
    for (const line of lines) {
      const record = parseTranscriptLine(line);
      if (record !== null) tail.meta = foldRecord(tail.meta, record);
    }
  };

  const initialScan = Effect.fn("ExternalSessionsWatcher.initialScan")(function* (
    slug: string,
    filePath: string,
    fileName: string,
    size: number,
    mtimeMs: number,
    nowMs: number,
  ) {
    const tail: FileTailState = {
      sessionId: fileName.slice(0, -".jsonl".length),
      projectSlug: slug,
      filePath,
      offset: size,
      carry: "",
      meta: emptyMetadata(),
      mtimeMs,
    };

    const headEnd = Math.min(size, HEAD_SCAN_BYTES);
    const headText = textDecoder.decode(yield* readRange(filePath, 0, headEnd));
    const headSplit = splitJsonlChunk(headText, "");
    foldLines(tail, headSplit.lines);

    if (headEnd >= size) {
      // Read to EOF: a partial trailing line continues on the next append.
      tail.carry = headSplit.carry;
    } else {
      const tailStart = Math.max(headEnd, size - TAIL_SCAN_BYTES);
      const tailText = textDecoder.decode(yield* readRange(filePath, tailStart, size));
      if (tailStart === headEnd) {
        const tailSplit = splitJsonlChunk(tailText, headSplit.carry);
        foldLines(tail, tailSplit.lines);
        tail.carry = tailSplit.carry;
      } else {
        // Jumped over the middle: the first line fragment is not a line start.
        const tailSplit = splitJsonlChunk(tailText, "");
        foldLines(tail, tailSplit.lines.slice(1));
        tail.carry = tailSplit.carry;
      }
    }

    tails.set(filePath, tail);
    yield* applyUpsert(snapshotOf(tail, nowMs));
  });

  const refreshFile = Effect.fn("ExternalSessionsWatcher.refreshFile")(function* (
    slug: string,
    dirPath: string,
    fileName: string,
    nowMs: number,
  ) {
    const filePath = pathService.join(dirPath, fileName);
    const info = yield* fs.stat(filePath);
    if (info.type !== "File") return;
    const size = Number(info.size);
    const mtimeMs = Option.match(info.mtime, {
      onNone: () => 0,
      onSome: (mtime) => mtime.getTime(),
    });

    const known = tails.get(filePath);

    if (nowMs - mtimeMs > MAX_SESSION_AGE_MS) {
      if (known !== undefined) {
        tails.delete(filePath);
        if (sessions.delete(known.sessionId)) {
          yield* PubSub.publish(eventsPubSub, { kind: "removed", sessionId: known.sessionId });
        }
      }
      return;
    }

    if (known === undefined) {
      yield* initialScan(slug, filePath, fileName, size, mtimeMs, nowMs);
      return;
    }

    known.mtimeMs = mtimeMs;
    if (size < known.offset) {
      // Rewritten or truncated (e.g. a clear): start over from scratch.
      tails.delete(filePath);
      yield* initialScan(slug, filePath, fileName, size, mtimeMs, nowMs);
      return;
    }

    if (size > known.offset) {
      let start = known.offset;
      let carry = known.carry;
      let skipFirstLine = false;
      if (size - start > MAX_TAIL_READ_BYTES) {
        start = size - MAX_TAIL_READ_BYTES;
        carry = "";
        skipFirstLine = true;
      }
      const bytes = yield* readRange(filePath, start, size);
      const split = splitJsonlChunk(textDecoder.decode(bytes), carry);
      foldLines(known, skipFirstLine ? split.lines.slice(1) : split.lines);
      known.offset = start + bytes.length;
      known.carry = split.carry;
    }

    yield* applyUpsert(snapshotOf(known, nowMs));
  });

  const refreshDir = (slug: string) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const dirPath = pathService.join(sessionsRoot, slug);
        const nowMs = yield* nowMillis;
        const entries = yield* fs
          .readDirectory(dirPath)
          .pipe(Effect.orElseSucceed(() => [] as Array<string>));
        // Sessions are ONLY the top-level *.jsonl files; a session's
        // companion `<uuid>/` dir (subagents, tool-results) is not a session.
        const fileNames = new Set(entries.filter((name) => name.endsWith(".jsonl")));

        for (const [filePath, tail] of tails) {
          if (tail.projectSlug !== slug) continue;
          if (fileNames.has(pathService.basename(filePath))) continue;
          tails.delete(filePath);
          if (sessions.delete(tail.sessionId)) {
            yield* PubSub.publish(eventsPubSub, { kind: "removed", sessionId: tail.sessionId });
          }
        }

        for (const fileName of fileNames) {
          // One unreadable file must not take down the dir refresh.
          yield* refreshFile(slug, dirPath, fileName, nowMs).pipe(
            Effect.ignoreCause({ log: true }),
          );
        }
      }),
    );

  const watchDir = Effect.fn("ExternalSessionsWatcher.watchDir")(function* (slug: string) {
    if (watchedSlugs.has(slug)) return;
    if (watchedSlugs.size >= MAX_WATCHED_DIRS) {
      yield* Effect.logWarning("external sessions: watched-dir cap reached, skipping", { slug });
      return;
    }
    watchedSlugs.add(slug);
    const dirPath = pathService.join(sessionsRoot, slug);
    // Debounce so a burst of appends coalesces into one refresh (the same
    // reasoning as the settings watcher, serverSettings.ts).
    const dirEvents = fs.watch(dirPath).pipe(Stream.debounce(Duration.millis(100)));
    yield* Stream.runForEach(dirEvents, () =>
      refreshDir(slug).pipe(Effect.ignoreCause({ log: true })),
    ).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(watcherScope), Effect.asVoid);
    yield* refreshDir(slug).pipe(Effect.ignoreCause({ log: true }));
  });

  const syncDirs = Effect.gen(function* () {
    if (candidateSlugs.size === 0) return;
    const rootExists = yield* fs.exists(sessionsRoot).pipe(Effect.orElseSucceed(() => false));
    if (!rootExists) return;
    for (const slug of candidateSlugs) {
      if (watchedSlugs.has(slug)) continue;
      const dirPath = pathService.join(sessionsRoot, slug);
      const dirExists = yield* fs.exists(dirPath).pipe(Effect.orElseSucceed(() => false));
      if (dirExists) yield* watchDir(slug);
    }
  });

  const decayStates = mutex.withPermits(1)(
    Effect.gen(function* () {
      const nowMs = yield* nowMillis;
      for (const tail of Array.from(tails.values())) {
        if (nowMs - tail.mtimeMs > MAX_SESSION_AGE_MS) {
          // Crossed the recency horizon while watched: age out entirely.
          tails.delete(tail.filePath);
          if (sessions.delete(tail.sessionId)) {
            yield* PubSub.publish(eventsPubSub, { kind: "removed", sessionId: tail.sessionId });
          }
          continue;
        }
        // Re-derive unconditionally: `working` decays to `idle`/`waiting`
        // and a dangling tool_use crosses into `waiting` purely by time
        // passing, with no FS event. `applyUpsert` drops no-op publishes.
        yield* applyUpsert(snapshotOf(tail, nowMs));
      }
    }),
  );

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true] as const);
    if (!shouldStart) return;

    const rootExists = yield* fs.exists(sessionsRoot).pipe(Effect.orElseSucceed(() => false));
    if (rootExists) {
      // Watch the sessions root itself so project dirs created after boot
      // (first Claude session in a known workspace) get picked up.
      const rootEvents = fs.watch(sessionsRoot).pipe(Stream.debounce(Duration.millis(500)));
      yield* Stream.runForEach(rootEvents, () =>
        syncDirs.pipe(Effect.ignoreCause({ log: true })),
      ).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(watcherScope), Effect.asVoid);
    }

    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(Duration.millis(STATE_DECAY_TICK_MS));
        yield* decayStates.pipe(Effect.ignoreCause({ log: true }));
      }
    }).pipe(Effect.forkIn(watcherScope), Effect.asVoid);
  }).pipe(Effect.asVoid);

  const ensureRoots = (roots: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      for (const root of roots) {
        candidateSlugs.add(encodeProjectSlug(pathService.resolve(root)));
      }
      yield* syncDirs;
    }).pipe(Effect.ignoreCause({ log: true }), Effect.asVoid);

  return ExternalSessionsWatcher.of({
    start,
    ensureRoots,
    snapshot: Effect.sync(() => Array.from(sessions.values())),
    get changes() {
      return Stream.fromPubSub(eventsPubSub);
    },
  });
});

export const layer = Layer.effect(ExternalSessionsWatcher, make);
