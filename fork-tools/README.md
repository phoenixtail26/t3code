# fork-tools/ — machine-side helpers for this fork (not upstream)

Scripts here are referenced by Windows Task Scheduler or run manually; they
are not part of any workspace package and nothing imports them.

## drift-check.ps1

Daily upstream-drift check. Fetches `upstream` in the main worktree
(`D:\Dev\t3code`), counts `g3code..upstream/main`, dry-runs the merge with
`git merge-tree`, and raises a Windows toast when drift ≥ 30 commits or any
conflict appears — the signal to run `/sync-upstream` while it is still
cheap. Logs every run to `%LOCALAPPDATA%\t3code-fork\drift-check.log`.

Registered as scheduled task **"T3Code Fork Upstream Drift Check"** (daily,
09:23, current user). To (re-)register after moving the repo or editing the
script path:

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File D:\Dev\t3code\fork-tools\drift-check.ps1'
$trigger = New-ScheduledTaskTrigger -Daily -At 09:23
Register-ScheduledTask -TaskName 'T3Code Fork Upstream Drift Check' `
  -Action $action -Trigger $trigger -Force `
  -Description 'Notifies when the t3code fork trails upstream by >=30 commits or the merge dry-run conflicts.'
```

The task runs against the MAIN worktree on purpose: fetch and merge-tree are
read-only for the working tree, and remote-tracking refs are shared across
all worktrees, so every agent's drift check benefits from the fresh fetch.
