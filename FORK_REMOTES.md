# Fork remotes and branch model

How this fork relates to upstream, and the two workflows that keep it healthy.
Set up 2026-07-18. Companion docs: `FORK_ORCHESTRATOR.md` (why this fork exists,
what changed), `FORK_ROADMAP.md` (where it is going), `RUN_FORK_WINDOWS.md`
(running/building here).

## Topology

| Remote     | URL                               | Role                  |
| ---------- | --------------------------------- | --------------------- |
| `origin`   | `github.com/phoenixtail26/t3code` | our fork — push here  |
| `upstream` | `github.com/pingdotgg/t3code`     | upstream — fetch only |

`upstream`'s push URL is deliberately set to the non-URL string
`DISABLED_PUSH_TO_ORIGIN_INSTEAD`, so an absent-minded `git push upstream` fails
loudly instead of attempting to write to someone else's repo.

| Branch           | Role                                                           |
| ---------------- | -------------------------------------------------------------- |
| `main`           | pristine mirror of `upstream/main` — **never commit here**     |
| `g3code`         | our product line; all fork work lands here                     |
| feature branches | cut from `g3code` (or from `main` if upstreamable — see below) |

Why `main` stays pristine: it makes every upstream sync a guaranteed
fast-forward, and keeps "theirs vs ours" unambiguous forever. If fork work lands
on `main`, every future sync becomes a three-way merge and the distinction
erodes permanently.

The fork is a real GitHub fork (public, parent `pingdotgg/t3code`), so
cross-fork compare views and upstream PRs work normally.

## Taking upstream updates

Use **`/sync-upstream`** — it encodes the full flow with its guards. The shape
of it (do not run these by hand unless the skill is unavailable):

```sh
git fetch upstream
git merge-base --is-ancestor main upstream/main && git branch -f main upstream/main
git push origin main
git -C <main-worktree> merge main    # conflicts land here, once
```

`main` is updated by ref (ancestry-guarded `branch -f`), not by checkout — no
worktree normally holds it, and the main worktree staying parked on `g3code` is
load-bearing for how new threads pick their base branch.

Conflict expectation: the fork's own files (`FORK_*`, `RUN_FORK_*`,
`CLAUDE_WINDOWS_*`, the usage-meter files) are additive and low-conflict. The
real contact points are `ClaudeAdapter.ts`, `ClaudeProvider.ts`,
`modelSelection.ts`, `Sidebar.tsx`, `ChatView.tsx` — small, surgical edits
inside upstream files.

### Cadence and responsibility — every agent, every session

Upstream moves fast (dozens of commits/week). Left alone, drift compounds:
the 2026-07-19 sync was 49 commits and one conflict file; a month of neglect
would be hundreds of commits and real conflicts.

**Before working in any upstream file** (anything outside the fork's own
`FORK_*`/`RUN_FORK_*`/skill files), check the drift — it costs seconds and
touches nothing:

```sh
git fetch upstream --quiet
git rev-list --count g3code..upstream/main                     # backlog size
git merge-tree --write-tree --name-only g3code upstream/main   # dry-run; grep CONFLICT
```

Then act on what you find:

- **Backlog under a week old and the dry-run is conflict-free** → run
  `/sync-upstream` yourself, as part of your session. Don't ask.
- **Backlog older than a week, or the dry-run shows conflicts** → propose the
  sync to the owner before proceeding: report the backlog size, the conflict
  list, and anything upstream landed in Claude-provider or Windows code. The
  owner picks the timing (other sessions may be mid-work in the merge target).
- **Either way, never build new fork features on top of week-stale code** in
  the contact files — that manufactures the next conflict.

The last-sync date is readable from `git log --merges -1 --format='%cs %s' g3code`.

## Sending a fix back to upstream

Branch from `main`, **not** `g3code` — otherwise the PR drags the whole product
line along:

```sh
git fetch upstream && git checkout -b fix/<topic> upstream/main
git cherry-pick <sha>          # the one commit
git push -u origin fix/<topic>
gh pr create --repo pingdotgg/t3code
```

Upstream currently says "not accepting contributions yet", so keep candidates
small and cherry-pickable and expect them to wait. Fixes #1 (Windows Claude
binary resolution) and #2 (Codex-default binding) are the standing candidates.

## Gotchas

- **Branch names stay lowercase.** `g3code`, not `g3Code`. Git refs are
  case-sensitive but Windows and macOS filesystems are not, so a
  case-differing pair collides unpredictably. The branch was renamed from
  `g3Code` on 2026-07-18 for exactly this reason.
- **The fork carries ~700 inherited branches.** GitHub copies every upstream
  branch at fork time (`codething/*`, `cursor/*`, `t3code/*`, …). They are a
  frozen snapshot — they never update — but they clutter the T3 ref picker
  under `origin/*`. To hide them locally without touching the remote, narrow
  the fetch refspec:
  ```sh
  git config --replace-all remote.origin.fetch '+refs/heads/main:refs/remotes/origin/main'
  git config --add remote.origin.fetch '+refs/heads/g3code:refs/remotes/origin/g3code'
  git config --add remote.origin.fetch '+refs/heads/fix/*:refs/remotes/origin/fix/*'
  git fetch origin --prune
  ```
- **Ref operations here are slow.** ~700 remote branches × 2 remotes means
  `git remote rename` and similar ref-rewriting commands take minutes and touch
  refs one at a time. Give them a generous timeout; a killed rename leaves
  `.lock` files under `.git/refs/remotes/<remote>/` that must be cleared
  manually before retrying. Remote-tracking refs are only a cache — if they get
  mangled, `git fetch <remote>` restores them.
- **Worktrees share one `.git`.** `D:\Dev\t3code`, `D:\Dev\t3code-notify`, and
  the `~\.t3\worktrees\t3code\*` checkouts all resolve to `D:\Dev\t3code\.git`.
  Remote config and branches are global across them; a branch checked out in one
  worktree cannot be checked out in another.

## New investigations

Base new threads on **`g3code`** with start-from-origin on. `main` is upstream's
code and contains none of the fork's work.
