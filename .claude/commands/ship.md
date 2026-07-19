---
description: Commit current work, merge it into g3code, and push to origin
---

Commit the current branch's work, merge it into `g3code`, and push to `origin`.

Commit message subject: $ARGUMENTS
(If empty, write one yourself from the actual diff.)

## Fork rules — these are not optional

- **Push target is always `origin`.** Never push to `upstream` (its push URL is
  deliberately set to `DISABLED_PUSH_TO_ORIGIN_INSTEAD`).
- **Never commit to, merge into, or push `main`.** `main` is a pristine mirror
  of `upstream/main`, kept clean so upstream syncs stay conflict-free. If the
  current branch is `main`, stop and say so rather than proceeding.
- **`g3code` is the integration branch.** All fork work lands there.

## Steps

**1. Identify where you are.**

```sh
git rev-parse --abbrev-ref HEAD    # current branch
git worktree list                  # first line is the MAIN worktree
```

The main worktree is the first line of `git worktree list` — derive its path,
don't hardcode it. Feature work usually runs in a linked worktree under
`~/.t3/worktrees/`.

**2. Commit, if there's anything to commit.**

Stage and commit on the current branch, in the current worktree. If the tree is
clean, skip to step 3 and say so — do not create an empty commit.

**3. If already on `g3code`, there is nothing to merge.** Push and stop:

```sh
git push origin g3code
```

**4. Otherwise, merge into `g3code` — from the MAIN worktree.**

This cannot run in the feature worktree: git refuses to check out `g3code`
there while the main worktree holds it. Run the merge with `-C <main-worktree>`.

Before merging, verify the main worktree is on `g3code` and clean:

```sh
git -C <main-worktree> rev-parse --abbrev-ref HEAD   # expect: g3code
git -C <main-worktree> status --short
```

If it is on some other branch, or dirty, **stop and report it**. Do not
check out or stash on the user's behalf — the main worktree being parked on
`g3code` is load-bearing for how new threads pick their base branch.

Then merge and push:

```sh
git -C <main-worktree> merge <feature-branch>
git -C <main-worktree> push origin g3code
```

On merge conflict: stop, report which files conflicted, and let the user
decide. Do not abort or auto-resolve.

**5. Push the feature branch only if it is a real named branch.**

`feat/*` and `fix/*` branches get pushed to `origin` for backup and PRs:

```sh
git push -u origin <feature-branch>
```

Auto-generated `t3code/<id>` thread branches are throwaway — do **not** push
them. Their content is already in `g3code` via the merge.

**6. Do not delete the worktree.** Cleanup is deliberate and user-driven.

## Report

State plainly: what was committed (sha + subject), whether a merge happened or
was skipped, what was pushed where, and anything that was stopped on. If a step
was skipped, say it was skipped rather than implying it succeeded.
