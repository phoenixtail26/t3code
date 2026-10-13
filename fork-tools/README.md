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

## rebuild-after-close.ps1

Foreground install, build and relaunch of the daily driver for builds that
need a dependency install, which cannot run while the app holds
`electron.exe`. The user closes the app and runs it in a terminal; `/build`
hands off to it with the exact wording (`.claude/commands/build.md`). It
refuses to start while the app is running, restores the previous artifacts if
the build fails, and logs to `D:\Dev\tools\t3code-rebuild.log`.

A Start Menu entry **"Rebuild T3 Code (fork)"** runs it in a window that stays
open (`-NoExit`) so the result is readable. To (re-)create it:

```powershell
$dir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
$s = (New-Object -ComObject WScript.Shell).CreateShortcut("$dir\Rebuild T3 Code (fork).lnk")
$s.TargetPath = (Get-Command pwsh.exe).Source
$s.Arguments = '-NoProfile -ExecutionPolicy Bypass -NoExit -File D:\Dev\t3code\fork-tools\rebuild-after-close.ps1'
$s.WorkingDirectory = 'D:\Dev\t3code'
$s.IconLocation = 'D:\Dev\t3code\apps\desktop\resources\icon.ico,0'
$s.Save()
```

It replaced a hidden scheduled task ("T3Code Fork Heal After Close") that
waited for the app to close and did the same steps unattended. That task ran
three times and failed three different ways (a build error, then twice a
`pnpm install` that hung after the build scripts), each needing a person to
read the output. A terminal the user is watching is the fix; nothing from
inside the app can be.
