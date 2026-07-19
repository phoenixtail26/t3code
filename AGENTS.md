# AGENTS.md

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `bun run sync:repos`; use `bun run sync:repos --repo <id>` to sync one
  configured repository.
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
changes already made, the roadmap, and the Windows environment gotchas
(portable Node path, `corepack pnpm`, broken root build filters, pre-existing
Windows test failures). `RUN_FORK_WINDOWS.md` covers running and building.

**Before running or testing anything, read `RUN_FORK_WINDOWS.md` — especially
"Dogfooding: testing a branch from inside t3code".** You are running inside the
app you are changing: the live instance owns `~\.t3\userdata`, and the session
you are working in is a thread in that database. Do not restart it and do not
point a second server at that state dir. Test a branch with `pnpm dev:desktop`
from the worktree, which uses a separate database and needs no pairing token.
The traps that waste the most time (auto-bootstrap defaulting off, dev vs
userdata stores, pairing token TTL) are all listed there.
`FORK_REMOTES.md` covers the remote topology, upstream syncing, and how to cut
an upstreamable PR branch.

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
