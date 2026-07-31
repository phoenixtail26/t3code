# Implementation plan: fork-a-thread + adopt-external-session (radar Phase 5 + roadmap #8)

Status (2026-07-31, evening): **F1–F6 IMPLEMENTED** — server stack plus web
UI ("Fork thread" in both sidebar context menus; "Adopt as thread" on radar
rows and the transcript view). See "How it actually landed" below for the
deltas from the original design. 30 focused tests green across contracts /
server / web. **Remaining: F7's live integrated pass** (isolated dev env,
throwaway scratch sessions only — see "Dogfooding hazard").

## How it actually landed (deltas from the design below)

- **No reactor.** Decision 2's "reactor step" was dropped after discovering
  that every reactor has its own DrainableWorker fiber over an independent
  PubSub subscription — a new reactor would RACE ProviderCommandReactor's
  turn-start handling with no ordering guarantee (and piggybacking inside
  ProviderCommandReactor would put fork lines + a new service dependency
  into an upstream conflict hotspot and break its test harness). Instead the
  fork RPC handler writes the binding synchronously (thread.create dispatch →
  `seedThreadSessionBinding` → only then return the new threadId). A turn can
  only be requested against a threadId the client knows, so the binding
  always lands before the first `startSession` read — ordering by
  construction. The `resumeCursor` on `thread.created` is provenance.
- **No `supportsSessionFork` capability.** The SDK's standalone
  `forkSession` is an in-process filesystem operation (no CLI spawn), so the
  wrapper is fully fork-owned (`threadFork/claudeSessionFork.ts`) and needs
  no adapter/capability plumbing. Gating is the driver-kind check in the
  handler + client (decision 6's v1 stance anyway).
- **v1 forks the whole session.** `fromMessageId` needs a t3-message →
  Claude-transcript-UUID mapping that doesn't exist; deferred to a later
  increment (an optionalKey field addition when it comes).
- **Config-dir stance follows the radar**: default `CLAUDE_CONFIG_DIR ??
~/.claude` only; custom per-instance homePath sessions fail with a clear
  fork error, same as they're invisible to the radar.
- **Adopt input is `{ sessionId, modelSelection }`** — the client supplies
  the model selection like every other thread-creation path; the server
  derives the project from the session cwd (same matching as the radar) and
  records the cwd as `worktreePath` when it isn't the project root.
- Files: `packages/contracts/src/threadFork.ts`,
  `apps/server/src/threadFork/{sessionSeed,claudeSessionFork,wsHandlers}.ts`
  (+ tests). Upstream-file mounts: ws.ts (1 import + 1 spread),
  RpcAuthorization.ts (1 import + 1 spread), rpc.ts (fork RPC block),
  orchestration.ts/decider.ts (F1 fields + passthrough).

Companion docs: `FORK_PLAN_RADAR.md` (phases 1–4, all shipped),
`apps/server/src/externalSessions/DESIGN.md` (radar module internals),
`FORK_ROADMAP.md` #1/#8.

## What the SDK gives us (verified in sdk.d.ts, vendored SDK)

Two independent fork mechanisms, both unused by t3code today:

1. `Options.forkSession?: boolean` (sdk.d.ts ~1465) — with `resume`, the
   resumed conversation continues under a NEW session id instead of
   appending to the old file. Combinable with a custom `sessionId`.
2. Standalone `forkSession(sessionId, { upToMessageId? })` (sdk.d.ts ~686)
   — copies the transcript to a new session file, remaps UUIDs, preserves
   the parentUuid chain, supports branching from a specific message;
   returns the new `{ sessionId }`, resumable via `resume`.

`resumeSessionAt` (resume up to+including a message UUID, sdk.d.ts ~1774)
is already threaded through the adapter's cursor (`ClaudeResumeState`), so
fork-from-any-point aligns with machinery that already exists.

Forked sessions carry no undo/file-history snapshots (SDK-documented) —
matches our checkpoint stance below.

## Verified seams (file:line as of e3c733606 — re-verify before editing)

- `ThreadCreateCommand` — contracts/orchestration.ts:527. No resumeCursor
  field. Decider handles `thread.create` at decider.ts:230-262.
- Thread creation does NOT start a provider session. Sessions start lazily
  on first turn: `ensureSessionForThread` → `startProviderSession`
  (ProviderCommandReactor.ts:474-486) → `ProviderService.startSession`
  (ProviderService.ts:522) → `ClaudeAdapter.startSession` (:3064).
- Bootstrap flow (`dispatchBootstrapTurnStart`, ws.ts:846-1050) composes:
  thread.create (:988) → optional worktree create (:1018-1024) →
  thread.meta.update (:1026-1032) → the original thread.turn.start.
- Claude cursor JSON: `{ threadId?, resume? (session UUID; legacy alias
sessionId), resumeSessionAt? (last assistant msg UUID), turnCount? }`.
  Read: `readClaudeResumeState` (ClaudeAdapter.ts:563-599). Written:
  `updateResumeCursor` (:1452-1470) and at session start (:3537-3542).
  Persisted in `provider_session_runtime.resume_cursor_json` via
  `ProviderSessionDirectory`.
- Adapter start: `resumeState?.resume` → SDK `resume` option; otherwise a
  fresh UUID → SDK `sessionId` option (:3096-3100, options :3448-3486).
- Own-session filter: `collectOwnSessionIds` (ownSessions.ts:38-75) reads
  persisted bindings AND live `providerService.listSessions()` cursors —
  a forked session's new id is covered the moment startSession writes
  `context.session.resumeCursor.resume` (:3537-3542). No new plumbing.
- History rendering: NO replay/backfill mechanism exists. A resumed t3
  thread shows history because its own event store holds it. A
  fork/adopt thread's event store starts EMPTY.
- Checkpoints: `thread.checkpoints` max-reduce tolerates zero entries;
  turn-0 revert falls back to HEAD (`fallbackToHead`, CheckpointReactor
  ~:630-691); revert to a missing turn ref short-circuits with a
  user-visible failure activity, not a crash. No changes needed.
- Capabilities: `ProviderAdapterCapabilities` (ProviderAdapter.ts:28-33,
  server-internal). Consumed e.g. ProviderCommandReactor.ts:519-527. NOT
  exposed to the client today — a client gate needs a new transport field
  or a driver-kind check.
- Per-message UI precedent: user-message hover actions in
  MessagesTimeline.tsx:947-963 (RevertUserMessageButton + copy). Thread
  action precedent: useThreadActions.ts confirmAndDeleteThread (:348-374).

## Design decisions

1. **Fork = SDK `forkSession(sessionId, { upToMessageId })` at command
   time, then a normal cursor-seeded thread.** Copying the transcript
   eagerly (mechanism 2) rather than fork-on-resume (mechanism 1) makes
   the new session id known synchronously, keeps the source file untouched
   forever after, and gives fork-from-message via `upToMessageId`. The new
   thread's binding is seeded with
   `{ threadId: <new>, resume: <newSessionId>, turnCount: 0 }`.
2. **Seed via the provider-session binding, not new reactor logic.** A new
   optional `resumeCursor` on `ThreadCreateCommand` (Schema.optionalKey —
   old stored events must decode) flows to a new reactor step that writes
   the binding through `ProviderSessionDirectory` at thread-create
   reaction time. First turn then resumes the forked session through the
   existing lazy-start path untouched.
3. **History rendering via transcript backfill events is OUT of v1.** The
   forked thread's timeline starts at the fork point with a system-style
   note ("Forked from <thread/session> — N prior turns carried in
   context"); the model retains full context regardless (that is the
   point). Rendering pre-fork history in the new thread is a later
   increment — candidates: reuse the Phase-4 transcript mapper as a
   read-only "prelude" section above the live timeline (no event-store
   writes), never synthetic orchestration events.
4. **Worktree strategy v1: share the parent's working tree** (adopt: the
   session's cwd — shared trees are already legal; worktreeCleanup only
   offers deletion when no other thread references the path). Offering
   fresh-worktree-on-fork is a later increment; the confirm dialog states
   the tree is shared and that pre-fork revert stays with the parent.
5. **Checkpoints: forked thread starts with none.** Existing null-handling
   suffices (verified above). Pre-fork revert/turn-diff remain parent-only.
6. **Gating: Claude-only via `ProviderAdapterCapabilities.supportsSessionFork`**
   (adapter-declared, false elsewhere). Client v1 gates on the thread's
   provider driver kind being claudeAgent (no transport change); a proper
   capability transport field can follow.

## Increments

| #   | Task                                                                                                                                                                                                                                                                                                         | Owner                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| F1  | Contracts: optional `resumeCursor` (Schema.optionalKey, Unknown) + optional `forkedFromThreadId` on `ThreadCreateCommand` and `thread.created` event; decode-compat test for pre-field stored events                                                                                                         | main                        |
| F2  | Reactor: on `thread.created` carrying `resumeCursor`, persist it as the thread's provider-session binding via `ProviderSessionDirectory` before any turn can start                                                                                                                                           | main                        |
| F3  | Adapter: `forkClaudeSession(sourceSessionId, { upToMessageId? })` service entry wrapping the SDK's standalone `forkSession` (spawned with the same executable/home resolution as startSession); `supportsSessionFork` capability                                                                             | main                        |
| F4  | Fork command path: WS RPC (fork-local wsHandlers module, mirroring the radar RPC pattern) `threads.forkThread { threadId, fromMessageId? }`: resolve source cursor → adapter fork → dispatch `thread.create` with seeded cursor (+ title "Fork of …", parent's project/worktree/model) → return new threadId | main                        |
| F5  | Web: "Fork from here" in the user-message hover actions + thread-level "Fork thread" action; confirm dialog (shared-tree note); navigate to the new thread on success. Gate on driver kind claudeAgent                                                                                                       | sonnet                      |
| F6  | Adopt-as-thread: same RPC with `{ externalSessionId }` source (radar snapshot → filePath/sessionId; idle-recency shown in confirm; fork-not-extend so the CLI session file is never written) + radar row action "Adopt"                                                                                      | main (server) / sonnet (UI) |
| F7  | Focused tests (F1 decode-compat, F2 binding write, F4 command flow with adapter stub) + test-t3-app pass: fork a live scratch thread mid-conversation, verify context retention + parent untouched; adopt a scratch CLI session                                                                              | main                        |

Sequencing: F1→F2→F3→F4 are strictly ordered (each consumes the previous);
F5 after F4; F6 after F4 (reuses everything); F7 rolling.

## Dogfooding hazard (same as radar phases)

Fork/adopt testing runs against throwaway CLI sessions in scratch projects
inside an isolated `vp run dev --home-dir` environment — never against the
live daily driver's sessions (this conversation is one of them).
