# This fork: T3 Code as a personal agent orchestrator

Read this first if you are an agent working in this checkout. It explains why this
fork exists and what has been changed and why. Companion docs:
`FORK_ROADMAP.md` (where the work is going),
`FORK_REMOTES.md` (remotes, branch model, upstream sync),
`RUN_FORK_WINDOWS.md` (how to run/build on this machine),
`CLAUDE_WINDOWS_AUTH_FIX.md` (deep-dive on the first bug), upstream `AGENTS.md`
(code conventions — follow them; the fork additions are at the bottom).

## The goal

The owner (ghayler@gmail.com, Windows 11, solo) runs many Claude Code sessions in
parallel — in Rider terminals, plain CLI windows, and headless test loops for a
Unity/SVN game project (`C:\Apollo\svn\unity\forsaken`). The pain: **zero
centralized visibility or control** — finding the one session blocked on input
meant clicking through windows.

Target state: **one place to see and steer all agent work.** T3 Code was chosen as
the platform after evaluating the field, because it is open source, its
architecture is right (a local server owning agent sessions + thin web/desktop
clients), and its bugs were fixable. This fork is that platform, patched and
extended toward the orchestrator role.

## The evaluation (2026-07-17) — why T3 Code

- **dev-3.0**: tmux + Electrobun core; no Windows target; a port is a rewrite.
- **Claude Code Remote Control**: enabled (auto-connect on) — good for steering
  live sessions from claude.ai/phone, but the surface is claude.ai only, no API,
  live processes only.
- **Claude Desktop app**: viable native host, but sessions must start there and
  it is not extensible by us.
- **ccmanager / Crystal / Vibe Kanban etc.**: tmux- or git-worktree-centric;
  forsaken is a giant SVN checkout — the isolation half of those tools cannot
  apply, and Windows support is weak across the category.
- **Key insight**: every Claude Code session, from any surface, writes JSONL
  transcripts to `~/.claude/projects/<slug>/`. Visibility over all sessions is a
  file-watching problem; control requires either hosting the session or Remote
  Control. T3 Code hosts sessions — and can grow the file-watching part (see
  `FORK_ROADMAP.md`).

## What has been changed in this fork (branch `g3code`)

1. **Windows Claude auth fix** (`ClaudeSdkExecutable.ts`) — upstream passes the
   bare string "claude" to the Agent SDK, which stats it as a literal path; npm
   installs on Windows only expose `.ps1`/`.cmd` shims, so every SDK spawn failed
   ("Could not verify Claude authentication status", upstream issue #2653 — whose
   apiKeySource theory is wrong). We resolve the real `bin\claude.exe` behind the
   shim. Details + A/B validation: `CLAUDE_WINDOWS_AUTH_FIX.md`. Upstreamable.
2. **Codex-default fix** (`resolveDefaultNewProjectModelSelection`) — upstream
   hardcodes `{instanceId: "codex", model: gpt}` as every new project's default
   selection; on Codex-less setups the model re-resolves against enabled
   providers while the instance id sticks, minting mismatched bindings whose
   turns fail with "Provider instance 'codex' is disabled". New projects now
   default to the first ready/enabled provider instance. Upstreamable.
3. **Claude plan-usage meter** — sidebar footer shows the session (5h) window
   percent at all times; weekly/scoped limits that cross warning/error get an
   alert row + escalation toasts; click/hover shows the full breakdown with
   reset countdowns. Server proxies Anthropic's OAuth usage endpoint (the data
   behind Claude Code's `/usage`) with the CLI's stored credentials, 60s cache,
   stale-while-error. Files: `packages/contracts/src/claudeUsage.ts`,
   `apps/server/src/provider/claudeUsage.ts`,
   `apps/web/src/components/sidebar/SidebarClaudeUsagePill.tsx`.
4. **Run tooling**: `start-t3code-desktop.ps1` (daily driver, Electron, no
   pairing) / `start-t3code.ps1` (headless server + browser). Start Menu
   shortcut "T3 Code (fork)". The winget upstream install was removed —
   unpatched, and its codex-default bug re-mints broken bindings.
5. **External session radar (MVP)** — sidebar "External" section per project
   showing Claude Code sessions started outside t3code (CLI, IDE terminals):
   title, working/idle/waiting state, last activity; 2-day recency horizon;
   off-switch
   in Settings (`showExternalSessions`). Server watches
   `~/.claude/projects/<slug>/*.jsonl` with a lenient parser (format is
   undocumented — see `apps/server/src/externalSessions/DESIGN.md`).
   Remaining phases (transcript view, adopt-as-thread) and next steps:
   `FORK_PLAN_RADAR.md`. Fork-local module `apps/server/src/externalSessions/`
   - `packages/contracts/src/externalSessions.ts`; surgical touches in
     `ws.ts`/`Sidebar.tsx`/`server.ts`.

Server-side data repairs already performed on the owner's `~\.t3\userdata` store:
all projects/threads rebound from `codex` to `claudeAgent` + `claude-fable-5`.

## Conclusions / operating decisions

- **Desktop app is the daily driver** (auto-authenticated window, no pairing
  tokens). Browser mode is for iteration (`pnpm dev`, hot reload) and remote
  access. Never run desktop and standalone server simultaneously (shared store).
- **Pairing tokens are single-use** and consumed on page load — biggest source
  of confusion during setup; see RUN_FORK_WINDOWS.md.
- **Remote Control auto-connect stays on** as the complementary layer: t3code
  hosts and steers its own sessions; RC covers steering CLI/Rider-hosted ones
  from claude.ai until `FORK_ROADMAP.md` #1 lands.
- **Upstream posture**: keep fixes small and cherry-pickable; upstream says "not
  accepting contributions yet", so candidate PRs (#1, #2) wait, but a corrective
  comment on upstream #2653 is worth posting. Work lives on `g3code`; `main`
  stays a pristine mirror of `upstream/main` and upstream lands via
  `merge --ff-only` then `main` → `g3code`. Full workflow, including how to cut
  an upstreamable PR branch, is in `FORK_REMOTES.md`. The fork's own files
  (FORK*\*, RUN*_, CLAUDE*WINDOWS*_, usage feature) are additive and
  low-conflict.

## Environment facts agents keep rediscovering (save yourself the time)

- Node: repo needs >= 24.13; system Node is older. Portable Node lives at
  `D:\Dev\tools\node-v24.18.0-win-x64` — prepend to PATH (`node --watch` and
  `import.meta.main` silently no-op on the system Node).
- `pnpm` is not on PATH; always `corepack pnpm`. `vp` (Vite+) is at
  `%USERPROFILE%\.vite-plus\bin`.
- Root `pnpm build` silently builds NOTHING on Windows (single-quoted filters
  via cmd.exe); pass filters explicitly — see RUN_FORK_WINDOWS.md.
- `ProviderRegistry.test.ts` has 16 pre-existing Windows failures (cmd.exe
  caret-escaping vs literal mock expectations) — not yours, don't chase them.
- The owner's Claude CLI is an npm install (`%APPDATA%\npm\claude.ps1`); no
  native claude.exe on PATH. This is why fix #1 exists.
