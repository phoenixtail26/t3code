# Fork remotes and branch model

How this fork relates to upstream, and the two workflows that keep it healthy.
Set up 2026-07-18. Companion docs: `FORK_ORCHESTRATOR.md` (why this fork exists,
what changed, roadmap), `RUN_FORK_WINDOWS.md` (running/building here).

## Topology

| Remote | URL | Role |
| --- | --- | --- |
| `origin` | `github.com/phoenixtail26/t3code` | our fork — push here |
| `upstream` | `github.com/pingdotgg/t3code` | upstream — fetch only |

`upstream`'s push URL is deliberately set to the non-URL string
`DISABLED_PUSH_TO_ORIGIN_INSTEAD`, so an absent-minded `git push upstream` fails
loudly instead of attempting to write to someone else's repo.

| Branch | Role |
| --- | --- |
| `main` | pristine mirror of `upstream/main` — **never commit here** |
| `g3code` | our product line; all fork work lands here |
| feature branches | cut from `g3code` (or from `main` if upstreamable — see below) |

Why `main` stays pristine: it makes every upstream sync a guaranteed
fast-forward, and keeps "theirs vs ours" unambiguous forever. If fork work lands
on `main`, every future sync becomes a three-way merge and the distinction
erodes permanently.

The fork is a real GitHub fork (public, parent `pingdotgg/t3code`), so
cross-fork compare views and upstream PRs work normally.

## Taking upstream updates

```sh
git fetch upstream
git checkout main && git merge --ff-only upstream/main   # always clean
git push origin main
git checkout g3code && git merge main                    # conflicts land here, once
```

Conflict expectation: the fork's own files (`FORK_*`, `RUN_FORK_*`,
`CLAUDE_WINDOWS_*`, the usage-meter files) are additive and low-conflict. The
real contact points are `ClaudeAdapter.ts`, `ClaudeProvider.ts`,
`modelSelection.ts`, `Sidebar.tsx` — small, surgical edits inside upstream files.

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
