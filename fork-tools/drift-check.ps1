# Fork tool: daily upstream-drift check for the t3code fork.
# Registered as the Windows scheduled task "T3Code Fork Upstream Drift Check"
# (see fork-tools/README.md). Fetches upstream in the MAIN worktree, measures
# how far g3code trails upstream/main, dry-runs the merge, and raises a toast
# when the sync is getting expensive: >= $CommitThreshold pending commits OR
# any dry-run conflict. Small syncs are cheap syncs — the point is to never
# accumulate another 120-commit merge.
#
# Read-only with respect to the repo (fetch only updates remote-tracking
# refs; merge-tree writes nothing to the working tree or index).

$ErrorActionPreference = 'Stop'
$Repo = 'D:\Dev\t3code'
$CommitThreshold = 30
$LogDir = Join-Path $env:LOCALAPPDATA 't3code-fork'
$LogFile = Join-Path $LogDir 'drift-check.log'
New-Item -ItemType Directory -Force $LogDir | Out-Null

function Write-Log([string]$message) {
    Add-Content -Path $LogFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
}

function Show-Toast([string]$title, [string]$body) {
    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
        $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
            [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $texts = $template.GetElementsByTagName('text')
        $texts.Item(0).AppendChild($template.CreateTextNode($title)) | Out-Null
        $texts.Item(1).AppendChild($template.CreateTextNode($body)) | Out-Null
        $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show(
            [Windows.UI.Notifications.ToastNotification]::new($template))
    } catch {
        # Toast plumbing is best-effort; the log always records the result.
        Write-Log "toast failed: $($_.Exception.Message)"
    }
}

try {
    & git -C $Repo fetch upstream --quiet 2>$null
    if ($LASTEXITCODE -ne 0) { throw "git fetch upstream failed (exit $LASTEXITCODE)" }

    $count = [int](& git -C $Repo rev-list --count g3code..upstream/main)
    $conflicts = @()
    if ($count -gt 0) {
        # merge-tree exits 1 when the result has conflicts — that is data, not failure.
        $mergeOutput = & git -C $Repo merge-tree --write-tree --name-only g3code upstream/main 2>&1
        $conflicts = @($mergeOutput | Where-Object { $_ -match '^CONFLICT' } |
            ForEach-Object { ($_ -replace '^CONFLICT \([^)]*\): Merge conflict in ', '') })
    }

    $oldest = ''
    if ($count -gt 0) {
        $oldest = (& git -C $Repo log --format='%cs' 'g3code..upstream/main' | Select-Object -Last 1)
    }

    Write-Log "drift=$count conflicts=$($conflicts.Count) oldest=$oldest"

    if ($conflicts.Count -gt 0 -or $count -ge $CommitThreshold) {
        $conflictNote = if ($conflicts.Count -gt 0) {
            "$($conflicts.Count) conflicting file(s): $(($conflicts | Select-Object -First 4) -join ', ')" +
            $(if ($conflicts.Count -gt 4) { ', …' } else { '' })
        } else { 'merges clean so far' }
        Show-Toast 'T3Code fork: upstream drift' `
            "$count commits behind upstream (oldest $oldest); $conflictNote. Run /sync-upstream soon."
    }
} catch {
    Write-Log "check failed: $($_.Exception.Message)"
    Show-Toast 'T3Code fork: drift check failed' $_.Exception.Message
}
