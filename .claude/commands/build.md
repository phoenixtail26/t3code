---
description: Rebuild the fork from source so the next app launch runs current code
---

Rebuild this fork's artifacts so that the **next** launch of the daily-driver
desktop app runs the current `g3code` code.

## What this does and does not do

- It rebuilds `apps/web/dist`, `apps/server/dist`, and
  `apps/desktop/dist-electron` in place.
- It does **not** restart the app. The running Electron process holds the old
  `main.cjs` in memory and only picks up the new one on restart.
- **Never restart the daily driver yourself.** The agent session you are talking
  to lives in that instance's database (`~\.t3\userdata`); restarting kills it
  mid-task. Tell the user to restart when convenient — that is their call.

## Build in the MAIN worktree

The daily driver launches from `D:\Dev\t3code` (branch `g3code`) — the Start
Menu shortcut runs `apps\desktop\node_modules\electron\dist\electron.exe`
against `dist-electron\main.cjs` with cwd `apps\desktop`. Building anywhere else
produces artifacts the launcher never loads.

Derive the main worktree from the first line of `git worktree list`; don't
assume the current directory. If the current branch is a feature branch whose
work is not yet merged into `g3code`, say so — this build will not include it.
To exercise unmerged work, the documented path is a second instance from the
worktree (`pnpm dev:desktop`, uses the isolated `~\.t3\dev` store), not this
command.

## The command

PATH needs three entries. All three matter:

```bash
export PATH="/d/Dev/tools/node-v24.18.0-win-x64:$HOME/.t3-bin:$HOME/.vite-plus/bin:$PATH"
export VP_NODE_MANAGER=no
cd <main-worktree>
corepack pnpm exec vp run --filter "./apps/*" --filter "./packages/*" build
```

- **Portable Node v24.18** — system Node is 24.1.0, below the 24.2 threshold
  where `import.meta.main` works; the dev-runner silently exits 0 on older Node.
- **`~/.t3-bin`** — corepack pnpm shims. Without these the build dies with
  `'pnpm' is not recognized ... Command failed: pnpm install`, because pnpm's
  dep-status check shells out to a bare `pnpm install`.
- **`~/.vite-plus/bin`** — the `vp` toolchain the build scripts run through.

Use `pnpm exec vp run` with **double**-quoted filters. Two traps here:

- `pnpm run build` at the root silently builds NOTHING: the script's
  single-quoted `'./apps/*'` filters reach vp literally through cmd.exe and
  match no packages, exiting 0.
- `pnpm run build:desktop` triggers pnpm's dep-status check and fails on the
  `pnpm install` shell-out. `pnpm exec vp` goes straight to vp and skips it.

## Verify it actually built — do not skip this

Silent no-op is the characteristic failure of this build, and it reports exit
code 0 when it happens. Two rules:

- **Do not pipe the build into `tail`/`head`.** The pipe returns the pager's
  exit status, hiding a failed build. Redirect to a log and check `$?`.
- **Compare artifact mtimes before and after:**

```bash
stat -c '%y %n' apps/desktop/dist-electron/main.cjs apps/web/dist/index.html
```

If the timestamps did not move, the build did nothing — report that as a
failure regardless of exit code. A healthy run reports packages built and
finishes in roughly 10-30s warm.

## Report

State what was rebuilt (with the before/after timestamps as evidence), which
branch was built, and remind the user the change is live only after they
restart the app themselves.
