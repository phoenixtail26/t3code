# Implementation plan: External session pickup (roadmap #1, "the radar")

Status: MVP (phases 1–3) implemented AND browser-verified 2026-07-20 on this
branch — 61 focused tests + package typechecks green; test-t3-app pass
confirmed live discovery, ai-title extraction, working→idle decay, and the
settings toggle against a scratch CLI session. Watcher test harness (1.5b)
still queued. Known MVP limitation confirmed in the flesh: subscription
captures project roots at subscribe time, so a newly added project needs a
page reload before its external sessions appear. Companion to `FORK_ROADMAP.md` #1;
grounded in a codebase survey run the same day (file:line references below are
from that survey — re-verify before editing, upstream moves).

**Goal:** t3code shows all Claude Code sessions on the machine (Rider
terminals, plain CLI) per project — state, title, last activity — with a
read-only transcript view and adopt-as-thread. Phase 5 deliberately builds the
provider primitives that roadmap #8 (fork a thread) needs, so build those
pieces general, not adoption-specific.

## Delegation model

Per `CLAUDE.md`: the main session's model is scarce (top-tier weekly window);
sonnet fanout is the lever. Rules used in the task tables below:

- **search** = `codebase-search-specialist` agent (pinned to sonnet). ALL
  exploration — never grep-campaign from the main session.
- **sonnet** = subagent with `model: "sonnet"` and a tight written spec:
  pattern-following implementation, test authoring, fixture capture, running
  builds/tests. If a sonnet task turns out to need real design judgment
  mid-flight, pull it back to main rather than accepting a mushy result.
- **main** = main-session model. Reserved for: Effect service design (scopes,
  semaphores, stream lifecycles — read `.repos/effect-smol/LLMS.md` first),
  event-sourced schema changes, `ClaudeAdapter` internals, race-condition
  design, and reviewing every sonnet deliverable before integration.
- Parallel implementation agents that write files get `isolation: "worktree"`.
- Integrated browser verification (`test-t3-app`) is the primary agent's job,
  once per user-visible milestone — subagents must not launch dev servers.

Before starting: run the FORK_REMOTES.md drift check. This plan touches
upstream files (`Sidebar.tsx`, `ws.ts`, `ProviderCommandReactor.ts`,
`packages/contracts`); do not build on stale code.

## MVP cutline

Phases 1–3 = shippable MVP: read-only sidebar radar, matched-projects only,
working/idle states from mtime, behind a setting. No transcript view, no
adoption, no "other" bucket, no waiting-on-permission state. Value increments
after MVP, in order: waiting-state detection → transcript route → adopt.

---

## Phase 1 — Discovery service (server)

New module `apps/server/src/externalSessions/`. Keep everything fork-local;
upstream files get one-line insertion points only.

| #   | Task                                                                                                                                                                                                                                                                                                                                                                                                                                               | Owner  | Notes                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | **Format spelunking**: sample real files under `~/.claude/projects/`, catalogue record types (roles, tool_use, summary/title records, cwd fields, sessionId), note Windows slug encoding, capture 4–6 sanitized fixture files into `apps/server/src/externalSessions/__fixtures__/`                                                                                                                                                                | sonnet | Read-only + fixture writing. Main reviews the catalogue before 1.2. Fixtures must not contain private prompt content — sanitize bodies, keep structure. |
| 1.2 | **Parser + state ladder design**: record-type mapping, lenient-parse rules (skip unknown lines, tolerate partial trailing line, never throw), state derivation (MVP: working/idle from mtime; later: waiting-on-permission from trailing records)                                                                                                                                                                                                  | main   | Small doc/spec, not code. The judgment core of the phase.                                                                                               |
| 1.3 | **Parser implementation + vitest suite** against the 1.1 fixtures, per the 1.2 spec                                                                                                                                                                                                                                                                                                                                                                | sonnet | Pure functions, no Effect services. Easy to verify against fixtures.                                                                                    |
| 1.4 | **Sessions-root resolution**: helper resolving `<configDir>/projects` via `resolveClaudeHomePath` (`ClaudeHome.ts:9`), mirroring `claudeUsage.ts:47`'s credentials-path helper. Respect `homePath`/`CLAUDE_CONFIG_DIR`                                                                                                                                                                                                                             | sonnet | Trivial + test.                                                                                                                                         |
| 1.5 | **Watcher/tailer service**: Effect service; `fs.watch` + `Stream.debounce(100ms)` per `serverSettings.ts:517-535`; per-file byte-offset tails; lazily watch only dirs matching known project roots; cap per-file read work; never full-file parse                                                                                                                                                                                                  | main   | The hardest server piece — Effect scopes/stream lifecycles + incremental-IO correctness. Sonnet writes the test harness afterward.                      |
| 1.6 | **Own-session filter + project matching**: exclude session UUIDs present in any thread `resumeCursor` (persisted via `ProviderSessionRuntime.ts`) AND ids allocated in-memory (covers the not-yet-persisted race and future fork-on-adopt files). Match cwd → `ProjectionProject.workspaceRoot` / thread `worktreePath` (inputs of `resolveThreadWorkspaceCwd`, `checkpointing/Utils.ts:12`) with Windows normalization (case, slashes, junctions) | main   | Race-condition + path-normalization judgment; small code.                                                                                               |

Phase-exit: focused vitest green (`vp test run` on the new module only).

## Phase 2 — Transport (server → client)

Standalone WS subscription — external FS state, NOT the event store.

| #   | Task                                                                                                                                                   | Owner  | Notes                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| 2.1 | **Contract types** in `packages/contracts` (schema-only): `ExternalSessionShell` (id, projectRef, title, state, lastActivityAt, cwd)                   | main   | Small but sets the API; optional-first fields for evolution.                                                  |
| 2.2 | **WS subscription** `subscribeExternalSessions`: snapshot-then-live per the `subscribeShell` pattern (`ws.ts:1064`), fed by the Phase-1 watcher stream | sonnet | Pattern-following with a precise spec; main reviews the scope/queue handling. One insertion point in `ws.ts`. |
| 2.3 | **Client atom** `useExternalSessionsForProject`, mirroring `useThreadShellsForProjectRefs` (`apps/web/src/state/entities.ts:121`)                      | sonnet | Pattern-following.                                                                                            |

## Phase 3 — Sidebar UI (MVP completes here)

| #   | Task                                                                                                                                                                                                                                                                                       | Owner  | Notes                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| 3.1 | **`ExternalSessionsSection` component** (new file): rows with title, state pill via `ThreadStatusLabel` (`ThreadStatusIndicators.tsx:132`) fed hand-built `ThreadStatusPill` objects (working → sky/pulse, idle → new muted variant), relative last-activity. Collapsed + quiet by default | sonnet | Self-contained new file; reuses existing visual language.                                                                |
| 3.2 | **Integration**: sibling of `SidebarProjectThreadList` inside `SidebarProjectItem` (`Sidebar.tsx:1088`); client setting to disable the radar entirely                                                                                                                                      | main   | `Sidebar.tsx` is ~3800 upstream lines and the fork's biggest merge surface — keep the diff to a few lines, main owns it. |
| 3.3 | Focused lint/typecheck on touched packages; then **`test-t3-app`** pass: see a scratch CLI session appear, change state, and disappear when the setting is off                                                                                                                             | main   | Skill mandates the primary agent; one isolated env.                                                                      |

## Phase 4 — Read-only transcript view

| #   | Task                                                                                                                                                                                             | Owner  | Notes                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------ |
| 4.1 | **Mapping design**: JSONL records → `OrchestrationMessage[]` (v1: user/assistant text; tool activity collapsed to work entries; drop the rest)                                                   | main   | Judgment about fidelity/lossiness.                     |
| 4.2 | **Server mapper + endpoint** implementing 4.1, with fixture-driven tests                                                                                                                         | sonnet | Pure mapping from the same Phase-1 fixtures.           |
| 4.3 | **`readOnly` prop on `MessagesTimeline`** gating revert/turn-diff affordances (none exists today; must also tolerate absent checkpoint history — forks/adoptions have no snapshots)              | sonnet | Mechanical prop-threading; main reviews the gate list. |
| 4.4 | **Route** `_chat.external.$sessionId.tsx` from the draft-route template; `kind: "external"` in `threadRoutes.ts:5`; own active-highlight logic (route params won't match `activeRouteThreadKey`) | sonnet | Pattern-following.                                     |
| 4.5 | `test-t3-app` pass on the transcript view                                                                                                                                                        | main   |                                                        |

## Phase 5 — Adopt as thread (shared groundwork for roadmap #8)

High blast radius: event-sourced contracts + adapter core. All main-model.

| #   | Task                                                                                                                                                                                                                                                                                                                                                                        | Owner                                | Notes                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | **Optional `resumeCursor` on `ThreadCreateCommand`** (`orchestration.ts:514`) + bootstrap path (`ws.ts:821`), threaded to `startProviderSession` (`ProviderCommandReactor.ts:474`). MUST be optional — stored events predating the field must still decode                                                                                                                  | main                                 | The seam roadmap #8 reuses verbatim (fork = seed from parent thread's cursor).                                                          |
| 5.2 | **`forkSession: true` wiring in `ClaudeAdapter`** (currently unused anywhere): adopt-as-fork so the original file is never extended; register the fork's new session id with the 1.6 filter before the SDK writes it                                                                                                                                                        | main                                 | Same primitive #8 needs; with `resumeSessionAt` already in every cursor (`ClaudeAdapter.ts:1456`), fork-from-message comes nearly free. |
| 5.3 | **Adopt action + guards**: Claude-only via provider capabilities; idle-recency check with "last active Xm ago" shown in the confirm (guard protects the working tree, not the transcript — forking never mutates the source file); adopted thread's `worktreePath` = session cwd when it differs from `workspaceRoot` (shared trees already legal, `worktreeCleanup.ts:25`) | main                                 | UI affordance itself (button/dialog) can go to sonnet off a spec.                                                                       |
| 5.4 | Focused tests (cursor seeding, schema decode of old events) + `test-t3-app` adoption pass **against a throwaway CLI session in a scratch project — never the live instance's sessions**                                                                                                                                                                                     | sonnet (tests) / main (browser pass) | Dogfooding hazard: this conversation is a file in the watched dir.                                                                      |

## Parallelization lanes

Sequential spine: 1.2 → 1.3/1.5 → 2.1. After 2.1 lands, three lanes run
concurrently (worktree isolation for the writers): (a) 2.2 server
subscription, (b) 2.3 atom + 3.1 component, (c) 1.1-fixture-based extras
(waiting-state spike, 4.2 mapper). Phase 5 strictly after MVP verification.

## Risks (ranked) and mitigations

1. **JSONL format is undocumented/unversioned** — permanent risk; lenient
   parser, mtime signals as the fallback floor, fixtures pinned so drift shows
   up as test failures.
2. **Own-session filter races** — ghost rows of t3code's own threads; filter
   covers in-memory-allocated ids, not just persisted cursors (1.6, 5.2).
3. **Idle guard protects the working tree, not the transcript** — fork-on-adopt
   makes transcript corruption impossible; recency shown to the user is the
   final check on shared-cwd edits.
4. **Watcher scale on Windows** — hundreds of dirs, multi-MB transcripts;
   lazy dir selection, offset tails, hard caps (1.5).
5. **Upstream merge surface** — fork logic in new files; `Sidebar.tsx`/`ws.ts`
   touches are few-line insertion points owned by main.
6. **Schema evolution** — optional fields only on persisted commands (5.1).
7. **Path normalization on Windows** — normalize both sides before cwd
   matching (1.6).

## Relationship to roadmap #8 (fork a thread)

Phase 5 IS the shared machinery: 5.1 (cursor-seeded thread creation), 5.2
(`forkSession` wiring + `resumeSessionAt`), 5.3's idle guard. After Phase 5,
#8 reduces to a per-message UI action plus the worktree-strategy decision
(share vs new-tree vs carry-dirty-state), which has no counterpart here.
