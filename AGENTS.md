# AGENTS.md

## Task Completion Requirements

- Keep local verification focused on the files and packages changed. Run the smallest relevant test set; do not run the full workspace test suite as a routine completion step.
  - Use `vp test run <test-files>` for focused built-in Vite+ tests. Use `vp run test` only when the affected package specifically requires its `test` script.
  - Backend changes must include and run focused tests for the changed behavior.
  - Run targeted formatting, lint, and type checks for the affected scope when available.
- Do not run repo-wide `vp check`, `vp run typecheck`, `vp run test`, or equivalent full-suite commands locally unless the user explicitly requests them. CI is responsible for the full verification suite.
- After frontend feature development or any user-visible frontend behavior change, the primary agent must use the `test-t3-app` skill once after integrating the work. Launch one isolated environment, authenticate through the printed pairing URL, and verify the affected flow in the controlled browser.
  - Subagents must not independently launch dev servers or repeat integrated browser verification unless their delegated task explicitly requires it.
  - Stop dev servers, watchers, and other long-running verification processes when the focused verification is complete.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vpr sync:repos`; use `vpr sync:repos --repo <id>` to sync one configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.

## Fork additions (not upstream — this checkout only)

This checkout is a personal fork (`phoenixtail26/t3code`) used as an
agent-orchestration platform. Fork work lives on the `g3code` branch; `main` is
a pristine mirror of `upstream/main` and must not be committed to.
**Read `FORK_ORCHESTRATOR.md` before starting work** — it carries the goal, the
changes already made, and the Windows environment gotchas (portable Node path,
`corepack pnpm`, broken root build filters, pre-existing Windows test
failures). `FORK_ROADMAP.md` carries the planned and in-flight work.
`RUN_FORK_WINDOWS.md` covers running and building.
`FORK_REMOTES.md` covers the remote topology, upstream syncing, and how to cut
an upstreamable PR branch.

**Upstream sync is every agent's job, not a special event.** Before working in
upstream files, run the drift check in FORK_REMOTES.md ("Cadence and
responsibility"): if upstream drift is under a week and merges clean, run
`/sync-upstream` yourself; if it is older than a week or the dry-run shows
conflicts, propose the sync to the owner before building on stale code. Use
`/ship` to land work on `g3code`, `/build` to rebuild the daily driver.

**Before running or testing anything, read `RUN_FORK_WINDOWS.md` — especially
"Dogfooding: testing a branch from inside t3code".** You are running inside the
app you are changing: the live instance owns `~\.t3\userdata`, and the session
you are working in is a thread in that database. Do not restart it and do not
point a second server at that state dir. Test a branch with `pnpm dev:desktop`
from the worktree, which uses a separate database and needs no pairing token.
The traps that waste the most time (auto-bootstrap defaulting off, dev vs
userdata stores, pairing token TTL) are all listed there.

### Subagent model usage

- Dispatch well-scoped, mechanical, or exploratory subagent work — codebase
  search, running builds/tests, log analysis, file discovery — with
  `model: "sonnet"`. The main session's model is for planning, design, and
  changes that need judgment.
- This is a guideline, not a hard rule: a subagent doing genuinely hard
  reasoning may use a stronger model when the task warrants it.
- The owner's plan-limit pressure is on the top-tier weekly window (visible in
  the sidebar usage meter this fork adds) — cheap-model fanout is the main
  lever for keeping it down.
