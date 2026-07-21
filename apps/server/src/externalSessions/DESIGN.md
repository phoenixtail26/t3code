# External sessions (the radar) — module design

Fork feature (see `FORK_PLAN_RADAR.md` at the repo root for the full plan).
This doc is the implementation spec for the discovery service: parser rules,
state ladder, and watcher architecture. Written 2026-07-20 from an empirical
survey of ~230 real session files; the JSONL format is undocumented and
unversioned, so treat every rule here as "observed", not "guaranteed".

## Source of truth on disk

Claude Code persists each session as
`<configDir>/projects/<project-slug>/<session-uuid>.jsonl` (one JSON object
per line, LF separators even on Windows, trailing newline, no BOM).
`configDir` resolution: `claudeSessionsRoot.ts` (mirrors the usage-meter's
`resolveClaudeCredentialsPath`; default `~/.claude`, honoring a non-empty
instance `homePath`). Like the usage meter, callers currently pass `""` —
custom `CLAUDE_CONFIG_DIR` instances are out of scope for now.

- **Sessions are ONLY the top-level `*.jsonl` files.** A session may have a
  companion directory `<session-uuid>/` holding `subagents/agent-*.jsonl` and
  `tool-results/*.txt` sidecars — never treat those as sessions; discovery
  must not recurse.
- **Slug encoding** (verified): every character outside `[A-Za-z0-9]` maps to
  `-`, one-to-one, no collapsing (`D:\Dev\x` → `D--Dev-x`,
  `C:\Users\u\.t3` → `C--Users-u--t3`). Deterministic path→slug; NOT
  reversible (a `-` can come from `\ : . _ @` or a literal `-`). Project
  identity therefore comes from the `cwd` field inside records, never from
  decoding the slug. Slugs are only used forward: known workspace root →
  expected dir name.

## Record shapes the parser must know

Observed top-level `type` values: `user`, `assistant`, `system`,
`attachment` (real discriminator nested at `attachment.type` — ~17
sub-types observed), plus standalone state lines with no `uuid`/`parentUuid`
/`timestamp`: `mode`, `permission-mode`, `bridge-session`, `last-prompt`,
`ai-title`, `custom-title`, `queue-operation`, `file-history-snapshot`.
Vanilla (non-forked) CLIs are believed to write `summary` records for titles
instead of `ai-title`/`custom-title` — support both.

Fields the MVP extracts (everything else is ignored):

| Field         | Where                      | Notes                                                                     |
| ------------- | -------------------------- | ------------------------------------------------------------------------- |
| `sessionId`   | almost every record        | matches filename; snake_case `session_id` is a DIFFERENT field, ignore it |
| `cwd`         | most chained records       | constant within a file in every sample; latest-wins anyway                |
| `timestamp`   | chained records            | ISO-8601 `Z`; standalone state lines have none                            |
| `aiTitle`     | `type:"ai-title"`          | can appear anywhere, repeatedly; latest wins                              |
| `customTitle` | `type:"custom-title"`      | ditto                                                                     |
| `summary`     | `type:"summary"` (vanilla) | field name `summary`; latest wins                                         |

Title ladder: `customTitle` > `aiTitle` > `summary` > `null` (UI falls back
to e.g. the session id prefix).

Hazards a parser MUST survive (all observed in real files):

- single lines up to ~350KB (pasted attachments) — cap: skip lines longer
  than `MAX_RECORD_BYTES` (1MB) without JSON-parsing them;
- truncated final line (process killed mid-append);
- key sets that drift MID-FILE (CLI upgraded during a session — `version`
  changed and new fields appeared between lines of one file): every line's
  schema is independent;
- non-object lines, empty lines, unknown `type`s: skip silently, never throw.

## Pure parser modules (task 1.3)

No Effect, no IO — plain functions over strings, testable against
`__fixtures__/`.

`transcriptRecords.ts`:

- `parseTranscriptLine(line: string): ExternalSessionRecord | null` —
  trim; empty/oversized/non-JSON/non-object → `null`. Returns only the
  MVP-relevant projection: `{ sessionId?, cwd?, timestamp?, title? }` where
  `title` is `{ kind: "custom" | "ai" | "summary", value: string }`.
- `splitJsonlChunk(chunk: string, carry: string): { lines: string[]; carry: string }`
  — carry-aware line splitter for the byte-offset tailer: prepend `carry`,
  split on `\n`, return complete lines + the trailing partial as new carry.
  (When a chunk is read from a mid-file offset that is not a line boundary,
  the caller passes `carry: ""` and drops the first returned line.)

`sessionMetadata.ts`:

- `ExternalSessionMetadata`: `{ sessionId, cwd, customTitle, aiTitle, summaryTitle, lastTimestamp }` (all nullable).
- `emptyMetadata()`, `foldRecord(meta, record)` (latest-wins everywhere),
  `resolveTitle(meta)` (the ladder above).
- `deriveExternalSessionState(nowMs, mtimeMs, meta): "working" | "idle" | "waiting"`
  — the state ladder:
  - `waiting` iff the last conversational record leaves a `tool_use`
    unanswered (`meta.pendingToolUse`), the session's last restated
    `permission-mode` is not `bypassPermissions`, and the file has been
    quiet ≥ `WAITING_THRESHOLD_MS` (30s). Outranks the mtime rungs and
    persists until the tool_use is answered — an overnight-blocked session
    stays flagged.
  - otherwise `working` iff `nowMs - mtimeMs < WORKING_THRESHOLD_MS`
    (120s: long thinking/tool gaps write nothing for a minute-plus; the
    cost of the wide threshold is only that an ended session shows
    "working" for ≤2 min); else `idle`.

  The `waiting` rung is a heuristic, and provably cannot be exact: a
  2026-07-21 survey of 195 recent transcripts (full record-type sweep,
  including live mid-call files) found **no content-level marker** for a
  pending permission prompt — blocked-on-approval and running-a-slow-tool
  are byte-identical tails (assistant `tool_use`, no `tool_result`,
  nothing in between; no progress records exist). mtime staleness is the
  only differing axis: dangling `tool_use` essentially never survives at
  rest in normal operation (1/195, and that one was live mid-call).
  Accepted false positive: a long-running approved tool in a session whose
  mode can prompt. The `bypassPermissions` suppression removes the
  headless/yolo class of long tool runs entirely. Tracking: the parser
  sets `pendingToolUse` true on non-sidechain `assistant` records carrying
  `tool_use` content blocks, false on any non-sidechain `user` or
  toolless-`assistant` record; standalone housekeeping lines have no
  opinion. `permission-mode` records are restated in every turn-complete
  housekeeping block, so the head+tail initial scan reliably sees one.

## Watcher service (task 1.5): `ExternalSessionsWatcher`

Effect service following the `serverSettings.ts`/`keybindings.ts` precedent
exactly: `Context.Service` class, `Layer.effect`, `PubSub.unbounded` +
`Stream.fromPubSub` for subscribers, a dedicated watcher `Scope` closed by a
layer finalizer, idempotent `start` (Ref guard + Deferred) invoked from
`ServerRuntimeStartup.make`. `FileSystem`/`Path` from the ambient
`PlatformServicesLive`.

Selection ("watch only what we can attribute"):

- Inputs: the set of candidate roots = every project `workspaceRoot` plus
  every thread `worktreePath` known to orchestration.
- `expectedSlug(root)` via the encoding rule; watched dirs = expected slugs
  that exist under the sessions root. The sessions root itself is watched to
  pick up newly created dirs.
- The projection is queried at subscribe/refresh time by the WS layer, not
  by the watcher itself (keeps the watcher free of orchestration deps and
  the layer ordering trivial). Root-set changes mid-connection surface on
  the next subscribe; documented limitation.

Per-file tail state: `{ offset: number, carry: string, meta: ExternalSessionMetadata, mtimeMs, sizeBytes }`.

- Initial scan of a dir: list `*.jsonl` (files only; skip companion dirs);
  per file stat + read head chunk (first 64KB → sessionId, cwd) and tail
  chunk (last 64KB → latest titles; drop the first partial line); set
  `offset = size`. Never read multi-MB middles — titles restate near the
  tail in practice; a missed mid-file `custom-title` is an accepted loss.
- On watch event (dir stream, `Stream.debounce(100ms)` per the settings
  precedent): re-stat changed file; if `size > offset` read only
  `[offset, size)`, fold new lines; if `size < offset` (rewrite/clear) reset
  and re-run the head+tail scan; cap any single read at
  `MAX_TAIL_READ_BYTES` (256KB) — if the delta is bigger, skip to
  `size - cap` and drop the first partial line.
- File deleted → session removed. Own sessions (1.6 filter) are dropped at
  emit time, not at watch time (cheap, and the filter's inputs change
  independently of the files).
- State decay: a 30s tick re-derives `working`→`idle` for sessions whose
  mtime aged past the threshold without new FS events (mtime never fires an
  event by itself).
- Recency horizon: sessions whose mtime is older than `MAX_SESSION_AGE_MS`
  (2 days) are skipped at scan time and aged out by the tick — long-lived
  projects accumulate hundreds of transcripts and the radar is for current
  work, not history. Resuming an ancient session is done by touching it
  (any activity in the CLI) — it reappears on the next dir event.
- Known edge (surfaced by the test harness): `start`/`watchDir` fork the
  `fs.watch` reader and return before it has attached, and the watcher is
  purely event-driven with no reconciliation pass — a change landing in that
  sub-second window is missed until an unrelated later event re-triggers a
  refresh. Unrealistic in production (sessions aren't created microseconds
  after server boot); the cheap fix if it ever matters is to piggyback a
  `syncDirs` + watched-dir refresh onto the 30s decay tick.

Emissions: `PubSub` carries full per-session snapshots
(`ExternalSessionShell`-shaped, see contracts task 2.1) plus removal
markers; subscribers get snapshot-then-live (current map first, then the
stream) like `subscribeShell` does.

## Own-session filter (task 1.6)

Exclude sessions t3code itself is driving:

- session UUIDs from every thread's persisted `resume_cursor_json`
  (`ProviderSessionRuntime`), plus
- UUIDs allocated in-memory but not yet persisted (registration point for
  the adapter; also covers future fork-on-adopt files).
- Candidate extra signal observed in the field survey: `bridge-session`
  records appear in sessions driven through a bridge — verify during 1.6
  whether t3code-driven sessions carry them and, if so, use as a
  belt-and-braces marker (never as the only filter).

cwd → project matching: normalize both sides (`path.resolve`, lower-case
drive letter, backslashes) before comparing against `workspaceRoot`/
`worktreePath`. Junction/symlink resolution is out of scope for MVP.
