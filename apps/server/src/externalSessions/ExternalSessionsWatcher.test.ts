// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off -- tests hand-build raw JSONL lines; the
// parser under test must not share a codec with its own fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { encodeProjectSlug } from "./projectSlug.ts";

// The watcher resolves its sessions root while its layer is built, so each
// test points this at a fresh temp dir before providing the layer.
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
// Computed as `ensureRoots` does, so the expected dir name tracks production.
const FAKE_SLUG = encodeProjectSlug(NodePath.resolve(FAKE_WORKSPACE_ROOT));
const OTHER_SLUG = encodeProjectSlug(NodePath.resolve(OTHER_WORKSPACE_ROOT));

/** The TestClock's "now". Files written during a test carry a real mtime that
 * lies after it, so they always count as fresh; only backdated files age. */
const NOW_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-18T12:00:00Z"));
const DIR_DEBOUNCE = Duration.millis(100);
const ROOT_DEBOUNCE = Duration.millis(500);
const DECAY_TICK = Duration.seconds(30);
const CHANGE: FileSystem.WatchEvent = { _tag: "Update", path: "" };

const tempRoots: string[] = [];

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

/** Sets the file's mtime to `age` before the TestClock's "now". */
function backdate(filePath: string, age: Duration.Duration): void {
  const seconds = (NOW_MS - Duration.toMillis(age)) / 1000;
  NodeFS.utimesSync(filePath, seconds, seconds);
}

const findSession = (
  sessions: ReadonlyArray<ExternalSessionSnapshot>,
  sessionId: string,
): ExternalSessionSnapshot | undefined =>
  sessions.find((session) => session.sessionId === sessionId);

const upsertOf =
  (sessionId: string, matches: (session: ExternalSessionSnapshot) => boolean) =>
  (event: ExternalSessionsEvent) =>
    event.kind === "upsert" && event.session.sessionId === sessionId && matches(event.session);

const removalOf = (sessionId: string) => (event: ExternalSessionsEvent) =>
  event.kind === "removed" && event.sessionId === sessionId;

/** Subscribes before the caller triggers the change and returns the effect that
 *  yields the first matching event. The PubSub subscription is only taken on the
 *  first pull, so the consumer must start immediately, not on the next tick. */
const nextChange = (
  changes: Stream.Stream<ExternalSessionsEvent>,
  predicate: (event: ExternalSessionsEvent) => boolean,
) =>
  Effect.map(
    Effect.forkChild(Stream.runHead(changes.pipe(Stream.filter(predicate))), {
      startImmediately: true,
    }),
    (consumer) => Effect.map(Fiber.join(consumer), Option.getOrThrow),
  );

interface Harness {
  readonly root: string;
  /** Deliver one change event to the watched slug dir / the sessions root. */
  readonly dirChanged: Effect.Effect<void>;
  readonly rootChanged: Effect.Effect<void>;
}

/** Runs `body` against a watcher rooted at a fresh temp dir whose directory
 *  watches are Queue-fed, so debounces and the decay tick run on the TestClock. */
const withWatcher = <A, E, R>(body: (harness: Harness) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-ext-sessions-"));
    tempRoots.push(root);
    currentSessionsRoot = root;
    yield* TestClock.setTime(NOW_MS);
    const rootEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
    const dirEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
    const watch = (_fs: FileSystem.FileSystem, path: string) =>
      Stream.fromQueue(path === root ? rootEvents : dirEvents);
    return yield* body({
      root,
      dirChanged: Queue.offer(dirEvents, CHANGE).pipe(Effect.asVoid),
      rootChanged: Queue.offer(rootEvents, CHANGE).pipe(Effect.asVoid),
    }).pipe(
      Effect.provide(ExternalSessionsWatcherModule.layer),
      Effect.provideService(ExternalSessionsWatcherModule.DirectoryWatch, watch),
    );
  });

it.layer(NodeServices.layer)("ExternalSessionsWatcher", (it) => {
  it.effect("initial scan discovers a pre-existing session with its title and cwd", () =>
    withWatcher(({ root }) =>
      Effect.gen(function* () {
        const sessionId = "11111111-1111-1111-1111-111111111111";
        NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
        NodeFS.writeFileSync(
          sessionFilePath(root, FAKE_SLUG, sessionId),
          readFixture("title-records.jsonl"),
        );

        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);

        const session = findSession(yield* watcher.snapshot, sessionId);
        assert.isDefined(session);
        assert.equal(session?.cwd, FAKE_WORKSPACE_ROOT);
        assert.equal(session?.projectSlug, FAKE_SLUG);
        // customTitle beats aiTitle: the fixture writes an ai-title then a custom-title.
        assert.equal(session?.title, "nightly build bug");
      }),
    ),
  );

  it.effect(
    "a live append updates the title through the byte-offset tail and emits an upsert",
    () =>
      withWatcher(({ root, dirChanged }) =>
        Effect.gen(function* () {
          const sessionId = "22222222-2222-2222-2222-222222222222";
          const filePath = sessionFilePath(root, FAKE_SLUG, sessionId);
          NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
          NodeFS.writeFileSync(filePath, minimalSessionContent(sessionId, { aiTitle: "Original" }));

          const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
          yield* watcher.start;
          yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);
          assert.equal(findSession(yield* watcher.snapshot, sessionId)?.title, "Original");

          const renamed = yield* nextChange(
            watcher.changes,
            upsertOf(sessionId, (session) => session.title === "Renamed"),
          );
          NodeFS.appendFileSync(
            filePath,
            line({ type: "custom-title", customTitle: "Renamed", sessionId }),
          );
          yield* dirChanged;
          yield* TestClock.adjust(DIR_DEBOUNCE);
          yield* renamed;

          assert.equal(findSession(yield* watcher.snapshot, sessionId)?.title, "Renamed");
        }),
      ),
  );

  it.effect("a session file appearing in a watched dir is discovered", () =>
    withWatcher(({ root, dirChanged }) =>
      Effect.gen(function* () {
        const sessionId = "33333333-3333-3333-3333-333333333333";
        NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });

        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);
        assert.isUndefined(findSession(yield* watcher.snapshot, sessionId));

        const discovered = yield* nextChange(
          watcher.changes,
          upsertOf(sessionId, () => true),
        );
        NodeFS.writeFileSync(
          sessionFilePath(root, FAKE_SLUG, sessionId),
          minimalSessionContent(sessionId),
        );
        yield* dirChanged;
        yield* TestClock.adjust(DIR_DEBOUNCE);
        yield* discovered;

        assert.equal(findSession(yield* watcher.snapshot, sessionId)?.cwd, FAKE_WORKSPACE_ROOT);
      }),
    ),
  );

  it.effect("a slug dir created after start is picked up through the sessions-root watch", () =>
    withWatcher(({ root, rootChanged }) =>
      Effect.gen(function* () {
        const sessionId = "44444444-4444-4444-4444-444444444444";

        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        // The slug dir does not exist yet, so nothing is watched.
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);
        assert.isUndefined(findSession(yield* watcher.snapshot, sessionId));

        const discovered = yield* nextChange(
          watcher.changes,
          upsertOf(sessionId, () => true),
        );
        NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
        NodeFS.writeFileSync(
          sessionFilePath(root, FAKE_SLUG, sessionId),
          minimalSessionContent(sessionId),
        );
        yield* rootChanged;
        yield* TestClock.adjust(ROOT_DEBOUNCE);
        yield* discovered;

        assert.isDefined(findSession(yield* watcher.snapshot, sessionId));
      }),
    ),
  );

  it.effect("a removed session file leaves the snapshot and emits a removal", () =>
    withWatcher(({ root, dirChanged }) =>
      Effect.gen(function* () {
        const sessionId = "55555555-5555-5555-5555-555555555555";
        const filePath = sessionFilePath(root, FAKE_SLUG, sessionId);
        NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
        NodeFS.writeFileSync(filePath, minimalSessionContent(sessionId));

        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);
        assert.isDefined(findSession(yield* watcher.snapshot, sessionId));

        const removed = yield* nextChange(watcher.changes, removalOf(sessionId));
        NodeFS.unlinkSync(filePath);
        yield* dirChanged;
        yield* TestClock.adjust(DIR_DEBOUNCE);
        yield* removed;

        assert.isUndefined(findSession(yield* watcher.snapshot, sessionId));
      }),
    ),
  );

  it.effect("tolerates a truncated final line and a non-JSON line, and keeps tailing", () =>
    withWatcher(({ root, dirChanged }) =>
      Effect.gen(function* () {
        const sessionId = "66666666-6666-6666-6666-666666666666";
        const filePath = sessionFilePath(root, FAKE_SLUG, sessionId);
        NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
        // A valid line, a garbage line, then a line cut mid-string with no newline.
        NodeFS.writeFileSync(
          filePath,
          line({
            type: "user",
            cwd: FAKE_WORKSPACE_ROOT,
            sessionId,
            timestamp: "2026-07-18T09:00:00.000Z",
          }) +
            "not valid json at all {\n" +
            '{"type":"ai-title","aiTitle":"Half-written state',
        );

        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);

        const session = findSession(yield* watcher.snapshot, sessionId);
        assert.isDefined(session);
        assert.equal(session?.cwd, FAKE_WORKSPACE_ROOT);
        assert.isNull(session?.title);

        const recovered = yield* nextChange(
          watcher.changes,
          upsertOf(sessionId, (next) => next.title === "Recovered"),
        );
        NodeFS.appendFileSync(
          filePath,
          `\n${line({ type: "custom-title", customTitle: "Recovered", sessionId })}`,
        );
        yield* dirChanged;
        yield* TestClock.adjust(DIR_DEBOUNCE);
        yield* recovered;

        assert.equal(findSession(yield* watcher.snapshot, sessionId)?.title, "Recovered");
      }),
    ),
  );

  it.effect("a companion subagent dir next to a session file is not a session", () =>
    withWatcher(({ root }) =>
      Effect.gen(function* () {
        const companionUuid = "77777777-7777-7777-7777-777777777777";
        const subagentDir = NodePath.join(slugDirFor(root, FAKE_SLUG), companionUuid, "subagents");
        NodeFS.mkdirSync(subagentDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(subagentDir, "agent-fakeagent0001.jsonl"),
          minimalSessionContent(companionUuid),
        );

        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);

        assert.deepEqual(yield* watcher.snapshot, []);
      }),
    ),
  );

  it.effect("a slug dir for a root never passed to ensureRoots is never scanned", () =>
    withWatcher(({ root }) =>
      Effect.gen(function* () {
        const otherSessionId = "88888888-8888-8888-8888-888888888888";
        NodeFS.mkdirSync(slugDirFor(root, OTHER_SLUG), { recursive: true });
        NodeFS.writeFileSync(
          sessionFilePath(root, OTHER_SLUG, otherSessionId),
          minimalSessionContent(otherSessionId),
        );

        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);

        assert.deepEqual(yield* watcher.snapshot, []);
      }),
    ),
  );

  it.effect("a session file older than the recency horizon is skipped at initial scan", () =>
    withWatcher(({ root }) =>
      Effect.gen(function* () {
        const sessionId = "99999999-9999-9999-9999-999999999999";
        const filePath = sessionFilePath(root, FAKE_SLUG, sessionId);
        NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
        NodeFS.writeFileSync(filePath, minimalSessionContent(sessionId));
        backdate(filePath, Duration.days(8));

        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);

        assert.deepEqual(yield* watcher.snapshot, []);
      }),
    ),
  );

  it.effect("appending to a stale session file resurrects it with the fresh title", () =>
    withWatcher(({ root, dirChanged }) =>
      Effect.gen(function* () {
        const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        const filePath = sessionFilePath(root, FAKE_SLUG, sessionId);
        NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
        NodeFS.writeFileSync(filePath, minimalSessionContent(sessionId));
        backdate(filePath, Duration.days(8));

        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);
        assert.deepEqual(yield* watcher.snapshot, []);

        // The append bumps mtime to the present, so the next dir refresh runs the
        // file through initialScan again; the new title proves it was rescanned.
        const resumed = yield* nextChange(
          watcher.changes,
          upsertOf(sessionId, () => true),
        );
        NodeFS.appendFileSync(
          filePath,
          line({ type: "custom-title", customTitle: "Resumed after a week", sessionId }),
        );
        yield* dirChanged;
        yield* TestClock.adjust(DIR_DEBOUNCE);
        const event = yield* resumed;

        assert.equal(event.kind === "upsert" ? event.session.title : null, "Resumed after a week");
      }),
    ),
  );

  it.effect("a stale dangling tool_use is waiting and recovers to working on its tool_result", () =>
    withWatcher(({ root, dirChanged }) =>
      Effect.gen(function* () {
        // Baked into the fixture, which ends on an unanswered Bash tool_use in
        // permission mode "default".
        const sessionId = "b10cced0-aaaa-4b7f-9716-327cdc3b1f92";
        const filePath = sessionFilePath(root, FAKE_SLUG, sessionId);
        NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
        NodeFS.writeFileSync(filePath, readFixture("dangling-tool-use.jsonl"));
        // Quiet past WAITING_THRESHOLD_MS (30s), inside the recency horizon.
        backdate(filePath, Duration.seconds(40));

        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);
        assert.equal(findSession(yield* watcher.snapshot, sessionId)?.state, "waiting");

        const working = yield* nextChange(
          watcher.changes,
          upsertOf(sessionId, (session) => session.state === "working"),
        );
        NodeFS.appendFileSync(
          filePath,
          line({
            type: "user",
            isSidechain: false,
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "toolu_01FAKE000000000000003", content: "ok" },
              ],
            },
            cwd: FAKE_WORKSPACE_ROOT,
            sessionId,
            timestamp: "2026-07-18T11:01:00.000Z",
          }),
        );
        yield* dirChanged;
        yield* TestClock.adjust(DIR_DEBOUNCE);
        yield* working;

        assert.equal(findSession(yield* watcher.snapshot, sessionId)?.state, "working");
      }),
    ),
  );

  it.effect("the decay tick moves a quiet session from working to idle without an fs event", () =>
    withWatcher(({ root }) =>
      Effect.gen(function* () {
        const sessionId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
        const filePath = sessionFilePath(root, FAKE_SLUG, sessionId);
        NodeFS.mkdirSync(slugDirFor(root, FAKE_SLUG), { recursive: true });
        NodeFS.writeFileSync(filePath, minimalSessionContent(sessionId));
        // 100s quiet: still inside WORKING_THRESHOLD_MS (120s) at scan time.
        backdate(filePath, Duration.seconds(100));

        const watcher = yield* ExternalSessionsWatcherModule.ExternalSessionsWatcher;
        yield* watcher.start;
        yield* watcher.ensureRoots([FAKE_WORKSPACE_ROOT]);
        assert.equal(findSession(yield* watcher.snapshot, sessionId)?.state, "working");

        const idle = yield* nextChange(
          watcher.changes,
          upsertOf(sessionId, (session) => session.state === "idle"),
        );
        yield* TestClock.adjust(DECAY_TICK);
        yield* idle;

        assert.equal(findSession(yield* watcher.snapshot, sessionId)?.state, "idle");
      }),
    ),
  );
});
