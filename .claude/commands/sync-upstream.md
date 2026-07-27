---
description: Merge upstream pingdotgg/t3code changes into g3code, with verification
---

Bring `upstream/main` into the fork: fast-forward `main`, merge it into
`g3code`, verify, push. The branch model this implements is documented in
`FORK_REMOTES.md`; the cadence policy (when to run this unprompted vs propose
it) lives there too.

## Fork rules — these are not optional

- `main` is a pristine mirror of `upstream/main`. It advances **only** by
  fast-forward. If the fast-forward guard fails, someone committed to `main` —
  stop and report; do not merge or rebase it.
- Push target is always `origin`. `upstream`'s push URL is deliberately broken
  (`DISABLED_PUSH_TO_ORIGIN_INSTEAD`); if a push to it ever succeeds, the
  remote config has been tampered with — stop and report.
- Never force-push anything in this flow. Every push here is a fast-forward by
  construction; if git says otherwise, something is wrong — stop and report.

## Steps

**1. Fetch and measure the drift.**

```sh
git fetch upstream
git fetch origin
git rev-list --count g3code..upstream/main   # commits we lack
git log --oneline --no-merges g3code..upstream/main | head -20
```

Ref operations in this repo are slow (~700 branches × 2 remotes) — give
fetches a generous timeout. A killed ref operation leaves stale `.lock` files
under `.git/refs/remotes/<remote>/`; if you hit "cannot lock ref", check for a
live git process first, then remove the `.lock` file and retry. Remote-tracking
refs are only a cache; `git fetch` rebuilds them.

**2. Dry-run the merge — free, touches nothing.**

```sh
git merge-tree --write-tree --name-only g3code upstream/main
```

Grep the output for `CONFLICT`. This is the honest preview of what step 5
will hit. Report the conflict list to the user **before** merging if there is
anything beyond the expected contact files (see step 5).

Also snapshot the fork's delta NOW, while `g3code` is still unmerged — step 6
compares against it to catch silently dropped fork lines:

```sh
BASE=$(git merge-base g3code upstream/main)
git diff $BASE g3code -- . ':!pnpm-lock.yaml' ':!*.gen.ts' \
  | awk '/^\+\+\+ /{f=substr($0,7)} /^\+[^+]/{print f": "substr($0,2)}' \
  | sort -u > /tmp/fork-lines-before
```

**3. Fast-forward `main` and back it up.**

`main` is normally not checked out in any worktree, so update the ref directly
— but only behind an ancestry guard:

```sh
git merge-base --is-ancestor main upstream/main \
  && git branch -f main upstream/main \
  || echo "STOP: main is not an ancestor of upstream/main"
git push origin main
```

**4. Merge from the MAIN worktree.**

The main worktree (first line of `git worktree list` — derive it, don't
hardcode) holds `g3code`. Verify it is on `g3code` and clean; if not, stop and
report rather than stashing on the user's behalf.

```sh
git -C <main-worktree> merge main -m "Merge upstream main into g3code"
```

**5. Resolve conflicts using the base, not guesswork.**

The fork's contact surface is ~60 upstream files — do not trust a hardcoded
list; derive the current one:

```sh
BASE=$(git merge-base g3code upstream/main)   # before the merge starts
for f in $(git diff --name-only $BASE g3code -- apps packages); do
  git cat-file -e "upstream/main:$f" 2>/dev/null && echo "$f"
done
```

Historic conflict hotspots: `ChatView.tsx`, `Sidebar.tsx`, `CommandPalette.tsx`,
`ChatMarkdown.tsx`, `SettingsPanels.tsx`, `contracts/{index,settings}.ts`, the
package.jsons, and `pnpm-lock.yaml` (never hand-merge the lockfile — take
theirs, then `corepack pnpm install --lockfile-only` to reconcile). Conflicts
in derived contact files are yours to resolve; conflicts in files the fork has
never touched are unexpected — resolve if clearly trivial, otherwise stop and
report. Most fork edits are one-line mounts (e.g. `<ForkSidebarPills />` in
`SidebarChrome.tsx`, handler spreads in `ws.ts`) — when re-applying one after
an upstream restructure, keep it one line; if a fork edit inside an upstream
file has grown past ~10 lines, extract it into a fork-owned file per
CLAUDE.md's fork rules instead of re-applying it inline.

For each conflict, diff all three stages before editing:

```sh
git show :1:<file>   # merge base — what both sides started from
git show :2:<file>   # ours (g3code)
git show :3:<file>   # theirs (upstream)
```

The usual shape: upstream rewrote a region the fork barely touched. Take
upstream's version wholesale and re-apply the fork's few lines on top —
historically `ChatView.tsx` resolves to "theirs + re-append the fork's
`fallbackDefaultModelSelection` memo". Do not keep stale fork copies of code
upstream has since restructured.

**6. Tripwire: check no fork line was silently dropped.**

Auto-merge can discard fork lines without raising a conflict (it happened in
the 2026-07-27 sync: a cleanly-merged `Sidebar.tsx` region lost a fork import,
and only typecheck caught it — and typecheck only catches drops that break
types). With conflicts resolved but BEFORE committing, re-diff and compare
against the step-2 snapshot:

```sh
git diff upstream/main -- . ':!pnpm-lock.yaml' ':!*.gen.ts' \
  | awk '/^\+\+\+ /{f=substr($0,7)} /^\+[^+]/{print f": "substr($0,2)}' \
  | sort -u > /tmp/fork-lines-after
comm -23 /tmp/fork-lines-before /tmp/fork-lines-after
```

Every line printed is a fork addition that no longer survives the merge.
Each one must be explainable: you consciously adopted upstream's rewrite of
that region, upstream absorbed the fork change, or the line moved file /
was reworded during resolution (a rewording shows up here as a "drop" —
confirm the replacement exists). An unexplained drop means the merge ate a
fork feature — restore it before committing. Do NOT re-add a line just
because it appears here: first check the three-stage diff; if the line was
upstream base code that upstream itself deleted, the drop is correct
(that exact trap — reflexively re-adding `useServerConfigs` — was nearly
shipped in the 2026-07-27 sync).

**7. Verify — semantic, not just textual.**

A clean auto-merge is not a correctness guarantee: step 6 only proves fork
lines still exist, not that they still do the right thing in upstream's
restructured surroundings. From the main worktree:

```sh
export PATH="/d/Dev/tools/node-v24.18.0-win-x64:$HOME/.t3-bin:$HOME/.vite-plus/bin:$PATH"
vp run typecheck
vp check
```

Both must pass (0 errors; warnings and effect-lint suggestions are
acceptable). Ignore the 16 known `ProviderRegistry.test.ts` Windows failures.
If upstream touched Claude provider files, say so in the report and recommend
a live smoke test (`/build`, then spawn a Claude session after the user
restarts).

**8. Commit and push.**

Commit via the Bash tool with a heredoc (`git commit --file=- <<'EOF'`), NOT a
PowerShell here-string — the `@'...'@` delimiters land as literal text in Git
Bash and mangle the subject. The pre-commit hook reformats staged files
mid-commit; verify the subject afterwards with `git log -1 --format='%s'`.

The message body should name what conflicted and how it was resolved — the
next sync's agent reads it.

```sh
git -C <main-worktree> push origin g3code
```

## Report

State: how many upstream commits came in and the notable ones (anything
touching Claude provider code, Windows behavior, or files the fork modifies),
which files conflicted and how each was resolved, verification results, and
what was pushed. If anything was stopped on, lead with that.
