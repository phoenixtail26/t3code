// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- this harness deliberately runs on the
// real clock (excludeTestServices: true, real fs.watch events); mtime
// backdating for recency tests measures real wall time, not Effect Clock time.
// @effect-diagnostics preferSchemaOverJson:off -- tests hand-build raw JSONL
// transcript lines on purpose; the parser under test must not share a codec
// with its own fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import { encodeProjectSlug } from "./projectSlug.ts";

/**
 * Redirects the watcher's sessions root to a per-test temp directory
 * WITHOUT touching production code. `ExternalSessionsWatcher.ts` calls
 * `resolveClaudeSessionsRoot("")` inside its `make` Effect.gen — i.e. at
 * layer-construction time, not at module load — so the mock closure only
 * needs to read whatever `currentSessionsRoot` holds at the moment each
 * test's layer is actually built (built after the mock is in place, since
 * each test reassigns `currentSessionsRoot` before providing the layer).
 */
let currentSessionsRoot = "";

vi.mock("./claudeSessionsRoot.ts", () => ({
  resolveClaudeSessionsRoot: () => currentSessionsRoot,
}));

import * as ExternalSessionsWatcherModule from "./ExternalSessionsWatcher.ts";
import type { ExternalSessionsEvent, ExternalSessionSnapshot } from "./ExternalSessionsWatcher.ts";

const testFileDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixturesDir = NodePath.join(testFileDir, "__fixtures__");

function readFixture(name: string): string {
  return NodeFS.readFileSync(NodePath.join(fixturesDir, name), "utf8");
}

// Matches the `cwd` baked into the __fixtures__ JSONL files.
const FAKE_WORKSPACE_ROOT = "C:\\fake\\project";
const OTHER_WORKSPACE_ROOT = "C:\\other\\project";
// Computed the same way the watcher computes it internally
// (`encodeProjectSlug(pathService.resolve(root))` in `ensureRoots`), so the
// expected slug dir name tracks production behavior exactly.
const FAKE_SLUG = encodeProjectSlug(NodePath.resolve(FAKE_WORKSPACE_ROOT));
const OTHER_SLUG = encodeProjectSlug(NodePath.resolve(OTHER_WORKSPACE_ROOT));

const tempRoots: string[] = [];

/** Creates a fresh temp sessions root and points the mocked
 *  `resolveClaudeSessionsRoot` at it. Must be called before the watcher
 *  layer is provided — the watcher captures the root at construction. */
function useTempSessionsRoot(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-ext-sessions-"));
  tempRoots.push(root);
  currentSessionsRoot = root;
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
  currentSessionsRoot = "";
});

function slugDirFor(root: string, slug: string): string {
  return NodePath.join(root, slug);
}

function sessionFilePath(root: string, slug: string, sessionId: string): string {
  return NodePath.join(slugDirFor(root, slug), `${sessionId}.jsonl`);
}

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

/** A minimal single-line session: a `user`-shaped record carrying `cwd` and
 *  `sessionId`, optionally with an `ai-title` line appended. */
function minimalSessionContent(sessionId: string, opts?: { aiTitle?: string }): string {
  let content = line({
    type: "user",
    cwd: FAKE_WORKSPACE_ROOT,
    sessionId,
    timestamp: "2026-07-18T09:00:00.000Z",
  });
  if (opts?.aiTitle !== undefined) {
    content += line({ type: "ai-title", aiTitle: opts.aiTitle, sessionId });
  }
  return content;
}

const findSession = (
  sessions: ReadonlyArray<ExternalSessionSnapshot>,
  sessionId: string,
): ExternalSessionSnapshot | undefined =>
  sessions.find((session) => session.sessionId === sessionId);

const POLL_INTERVAL_MS = 50;

/** `watchDir`/`start` fork the `fs.watch` stream reader onto its own fiber
 *  rather than blocking until the OS-level watch is attached; forking a
 *  fiber does not guarantee it has run before the caller continues. A test
 *  that mutates the filesystem immediately after `ensureRoots`/`start`
 *  returns can therefore race the watch attaching and miss the one event
 *  it was waiting for (nothing re-checks later, since the watcher is
 *  purely event-driven). This is a real, if narrow, product edge case —
 *  see the test report — but for test determinism we simply give the
 *  forked watcher fiber a moment to attach before mutating. */
const WATCH_ATTACH_SETTLE_MS = 250;

/** Polls `effect` until `predicate` holds or `timeoutMs` elapses (Windows
 *  `fs.watch` delivery can lag), returning the last observed value either
 *  way — the caller's own assertion produces the failure message when the
 *  deadline is hit without the condition being met. Uses real wall-clock
 *  time deliberately: the watcher's debounces run on the live Clock against
 *  real `fs.watch` events, so there is no virtual clock to advance. */
const waitFor = <A>(
  effect: Effect.Effect<A>,
  predicate: (value: A) => boolean,
  timeoutMs = 8000,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    const deadline = DateTime.toEpochMillis(yield* DateTime.now) + timeoutMs;
    while (true) {
      const value = yield* effect;
      if (predicate(value)) return value;
      if (DateTime.toEpochMillis(yield* DateTime.now) >= deadline) return value;
      yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
    }
  });

/** Polls `effect` repeatedly across `durationMs`, asserting `predicate` holds
 *  every time — the inverse of `waitFor`'s "wait for true" semantics, for
 *  "stays false" assertions where waiting out a full timeout would be
 *  needlessly slow. */
const assertStaysTrue = <A>(
  effect: Effect.Effect<A>,
  predicate: (value: A) => boolean,
  durationMs: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = DateTime.toEpochMillis(yield* DateTime.now) + durationMs;
    while (DateTime.toEpochMillis(yield* DateTime.now) < deadline) {
      const value = yield* effect;
      assert.isTrue(predicate(value));
      yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
    }
  });

/** Subscribes to `watcher.changes` and collects events into a Ref, returning
 *  it once the subscription has had time to attach. PubSub subscribers only
 *  see events published after they subscribe, so callers must await this
 *  before triggering the change they want to observe. */
const collectChanges = () =>
  Effect.gen(function* () {
    const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
    const eventsRef = yield* Ref.make<ExternalSessionsEvent[]>([]);
    yield* Stream.runForEach(watcher.changes, (event) =>
      Ref.update(eventsRef, (events) => [...events, event]),
    ).pipe(Effect.forkScoped);
    yield* Effect.sleep(Duration.millis(150));
    return eventsRef;
  });

// `it.effect` defaults to a virtual TestClock (see @effect/vitest's
// `TestEnv`), which would freeze the watcher's real `Stream.debounce`
// timers and our own polling `Effect.sleep` calls forever — the debounces
// race against real `fs.watch` events, so the live Clock is required here.
it.layer(NodeServices.layer, { excludeTestServices: true })("ExternalSessionsWatcher", (it) => {
  it.effect(
    "1. initial scan discovers a pre-existing session file with resolved title and cwd",
    () => {
      const root = useTempSessionsRoot();
      const sessionId = "11111111-1111-1111-1111-111111111111";
      NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
      NodeFS.writeFileSync(
        sessionFilePath(root, FAKE_SLUG, sessionId),
        readFixture("title-records.jsonl"),
      );

      return Effect.gen(function* () {
        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);

        const sessions = yield* waitFor(
          watcher.snapshot,
          (snapshot) => findSession(snapshot, sessionId) !== undefined,
        );
        const session = findSession(sessions, sessionId);

        assert.isDefined(session);
        assert.equal(session?.cwd, FAKE_WORKSPACE_ROOT);
        assert.equal(session?.projectSlug, FAKE_SLUG);
        // customTitle beats aiTitle in the title ladder: the fixture writes
        // an ai-title then a custom-title.
        assert.equal(session?.title, "nightly build bug");
      }).pipe(Effect.provide(ExternalSessionsWatcherModule.layer));
    },
    10_000,
  );

  it.effect(
    "2. live append updates the title via the byte-offset tail and emits an upsert",
    () => {
      const root = useTempSessionsRoot();
      const sessionId = "22222222-2222-2222-2222-222222222222";
      NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
      NodeFS.writeFileSync(
        sessionFilePath(root, FAKE_SLUG, sessionId),
        minimalSessionContent(sessionId, { aiTitle: "Original title" }),
      );

      return Effect.gen(function* () {
        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);
        yield* waitFor(
          watcher.snapshot,
          (snapshot) => findSession(snapshot, sessionId) !== undefined,
        );

        const eventsRef = yield* collectChanges();

        NodeFS.appendFileSync(
          sessionFilePath(root, FAKE_SLUG, sessionId),
          line({ type: "custom-title", customTitle: "Renamed", sessionId }),
        );

        const sessions = yield* waitFor(
          watcher.snapshot,
          (snapshot) => findSession(snapshot, sessionId)?.title === "Renamed",
        );
        assert.equal(findSession(sessions, sessionId)?.title, "Renamed");

        const events = yield* Ref.get(eventsRef);
        assert.isTrue(
          events.some(
            (event) =>
              event.kind === "upsert" &&
              event.session.sessionId === sessionId &&
              event.session.title === "Renamed",
          ),
        );
      }).pipe(Effect.provide(ExternalSessionsWatcherModule.layer));
    },
    10_000,
  );

  it.effect(
    "3. a new session file appearing in an already-watched dir is eventually discovered",
    () => {
      const root = useTempSessionsRoot();
      const sessionId = "33333333-3333-3333-3333-333333333333";
      NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });

      return Effect.gen(function* () {
        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);
        assert.isUndefined(findSession(yield* watcher.snapshot, sessionId));
        yield* Effect.sleep(Duration.millis(WATCH_ATTACH_SETTLE_MS));

        NodeFS.writeFileSync(
          sessionFilePath(root, FAKE_SLUG, sessionId),
          minimalSessionContent(sessionId),
        );

        const sessions = yield* waitFor(
          watcher.snapshot,
          (snapshot) => findSession(snapshot, sessionId) !== undefined,
        );
        assert.isDefined(findSession(sessions, sessionId));
      }).pipe(Effect.provide(ExternalSessionsWatcherModule.layer));
    },
    10_000,
  );

  it.effect(
    "4. a slug dir created after start is picked up via the sessions-root watcher",
    () => {
      const root = useTempSessionsRoot();
      const sessionId = "44444444-4444-4444-4444-444444444444";

      return Effect.gen(function* () {
        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        // ensureRoots is called while the slug dir does NOT exist yet.
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);
        assert.isUndefined(findSession(yield* watcher.snapshot, sessionId));
        yield* Effect.sleep(Duration.millis(WATCH_ATTACH_SETTLE_MS));

        NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
        NodeFS.writeFileSync(
          sessionFilePath(root, FAKE_SLUG, sessionId),
          minimalSessionContent(sessionId),
        );

        // The sessions-root watcher debounces at 500ms; allow a generous
        // deadline on top of that for Windows fs.watch lag.
        const sessions = yield* waitFor(
          watcher.snapshot,
          (snapshot) => findSession(snapshot, sessionId) !== undefined,
          8000,
        );
        assert.isDefined(findSession(sessions, sessionId));
      }).pipe(Effect.provide(ExternalSessionsWatcherModule.layer));
    },
    15_000,
  );

  it.effect(
    "5. a removed session file disappears from the snapshot and emits a removal",
    () => {
      const root = useTempSessionsRoot();
      const sessionId = "55555555-5555-5555-5555-555555555555";
      NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
      NodeFS.writeFileSync(
        sessionFilePath(root, FAKE_SLUG, sessionId),
        minimalSessionContent(sessionId),
      );

      return Effect.gen(function* () {
        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);
        yield* waitFor(
          watcher.snapshot,
          (snapshot) => findSession(snapshot, sessionId) !== undefined,
        );

        const eventsRef = yield* collectChanges();

        NodeFS.unlinkSync(sessionFilePath(root, FAKE_SLUG, sessionId));

        const sessions = yield* waitFor(
          watcher.snapshot,
          (snapshot) => findSession(snapshot, sessionId) === undefined,
        );
        assert.isUndefined(findSession(sessions, sessionId));

        const events = yield* Ref.get(eventsRef);
        assert.isTrue(
          events.some((event) => event.kind === "removed" && event.sessionId === sessionId),
        );
      }).pipe(Effect.provide(ExternalSessionsWatcherModule.layer));
    },
    10_000,
  );

  it.effect(
    "6. tolerates a truncated final line and a non-JSON line, and keeps processing appends",
    () => {
      const root = useTempSessionsRoot();
      const sessionId = "66666666-6666-6666-6666-666666666666";
      NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
      // A valid line, a non-JSON garbage line, then a final line cut
      // mid-JSON-string with no trailing newline (crash/kill before flush).
      const garbageContent =
        line({
          type: "user",
          cwd: FAKE_WORKSPACE_ROOT,
          sessionId,
          timestamp: "2026-07-18T09:00:00.000Z",
        }) +
        "not valid json at all {\n" +
        '{"type":"ai-title","aiTitle":"Half-written state';
      NodeFS.writeFileSync(sessionFilePath(root, FAKE_SLUG, sessionId), garbageContent);

      return Effect.gen(function* () {
        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);

        const sessions = yield* waitFor(
          watcher.snapshot,
          (snapshot) => findSession(snapshot, sessionId) !== undefined,
        );
        const session = findSession(sessions, sessionId);
        assert.isDefined(session);
        assert.equal(session?.cwd, FAKE_WORKSPACE_ROOT);
        assert.isNull(session?.title);

        // Append a well-formed line; the watcher must still be alive and
        // keep tailing despite the earlier garbage/truncated content.
        NodeFS.appendFileSync(
          sessionFilePath(root, FAKE_SLUG, sessionId),
          `\n${JSON.stringify({ type: "custom-title", customTitle: "Recovered", sessionId })}\n`,
        );

        const recovered = yield* waitFor(
          watcher.snapshot,
          (snapshot) => findSession(snapshot, sessionId)?.title === "Recovered",
        );
        assert.equal(findSession(recovered, sessionId)?.title, "Recovered");
      }).pipe(Effect.provide(ExternalSessionsWatcherModule.layer));
    },
    10_000,
  );

  it.effect(
    "7. a companion subagent dir next to a session file is not treated as a session",
    () => {
      const root = useTempSessionsRoot();
      const companionUuid = "77777777-7777-7777-7777-777777777777";
      const subagentDir = NodePath.join(slugDirFor(root, FAKE_SLUG), companionUuid, "subagents");
      NodeFS.mkdirSync(subagentDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(subagentDir, "agent-fakeagent0001.jsonl"),
        minimalSessionContent(companionUuid),
      );

      return Effect.gen(function* () {
        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);

        // refreshDir runs synchronously as part of ensureRoots for a
        // pre-existing dir, so there is nothing to poll for here.
        const sessions = yield* watcher.snapshot;
        assert.isUndefined(findSession(sessions, companionUuid));
        assert.equal(sessions.length, 0);
      }).pipe(Effect.provide(ExternalSessionsWatcherModule.layer));
    },
  );

  it.effect("8. a slug dir for a root never passed to ensureRoots is never scanned", () => {
    const root = useTempSessionsRoot();
    const otherSessionId = "88888888-8888-8888-8888-888888888888";
    NodeFS.mkdirSync(slugDirFor(root, OTHER_SLUG), { recursive: true });
    NodeFS.writeFileSync(
      sessionFilePath(root, OTHER_SLUG, otherSessionId),
      minimalSessionContent(otherSessionId),
    );

    return Effect.gen(function* () {
      const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
      yield* watcher.start;
      // Only FAKE_WORKSPACE_ROOT is registered; OTHER_SLUG's dir is never a
      // candidate and so is never scanned, regardless of what's on disk.
      yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);

      const sessions = yield* watcher.snapshot;
      assert.isUndefined(findSession(sessions, otherSessionId));
      assert.equal(sessions.length, 0);
    }).pipe(Effect.provide(ExternalSessionsWatcherModule.layer));
  });

  it.effect(
    "9. a session file older than the recency horizon is skipped at initial scan",
    () => {
      const root = useTempSessionsRoot();
      const sessionId = "99999999-9999-9999-9999-999999999999";
      NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
      const filePath = sessionFilePath(root, FAKE_SLUG, sessionId);
      NodeFS.writeFileSync(filePath, minimalSessionContent(sessionId));
      // 8 days old — past MAX_SESSION_AGE_MS (7 days) — set before the
      // watcher ever sees the file, so refreshFile's age check on the
      // initial scan is what's under test, not the decay tick.
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      NodeFS.utimesSync(filePath, eightDaysAgo, eightDaysAgo);

      return Effect.gen(function* () {
        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);

        yield* assertStaysTrue(
          watcher.snapshot,
          (snapshot) => findSession(snapshot, sessionId) === undefined,
          1500,
        );
      }).pipe(Effect.provide(ExternalSessionsWatcherModule.layer));
    },
    10_000,
  );

  it.effect(
    "10. appending to a stale session file resurrects it with the fresh title",
    () => {
      const root = useTempSessionsRoot();
      const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
      const filePath = sessionFilePath(root, FAKE_SLUG, sessionId);
      NodeFS.writeFileSync(filePath, minimalSessionContent(sessionId));
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      NodeFS.utimesSync(filePath, eightDaysAgo, eightDaysAgo);

      return Effect.gen(function* () {
        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);

        yield* assertStaysTrue(
          watcher.snapshot,
          (snapshot) => findSession(snapshot, sessionId) === undefined,
          1500,
        );

        // The documented "resume an ancient session" workflow: appending a
        // line also bumps mtime to now, bringing the file back within the
        // recency horizon on the next dir refresh. Because the file was
        // never tracked (skipped at initial scan), this re-discovery runs
        // through `initialScan` again — asserting on the appended title
        // proves the file was actually rescanned, not served from stale
        // in-memory state.
        NodeFS.appendFileSync(
          filePath,
          line({ type: "custom-title", customTitle: "Resumed after a week", sessionId }),
        );

        const sessions = yield* waitFor(
          watcher.snapshot,
          (snapshot) => findSession(snapshot, sessionId) !== undefined,
        );
        assert.equal(findSession(sessions, sessionId)?.title, "Resumed after a week");
      }).pipe(Effect.provide(ExternalSessionsWatcherModule.layer));
    },
    10_000,
  );

  // Deliberately out of scope: the 30s working->idle decay tick needs 120s+
  // of wall time (WORKING_THRESHOLD_MS) to observe end-to-end through the
  // watcher. deriveExternalSessionState itself is already unit-tested in
  // sessionMetadata.test.ts.
});
