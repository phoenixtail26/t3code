# One-shot heal for the t3code fork after an upstream sync that changed
# dependencies: waits for the daily driver to exit, installs the new dependency
# set, rebuilds the artifacts, relaunches the app, and deletes its own task.
# Registered by /build (see .claude/commands/build.md); log at
# D:\Dev\tools\t3code-heal.log, kept outside the worktree so it never shows up
# in git status. The user must leave the app closed until this script reopens it.

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$electronExe = "$repo\apps\desktop\node_modules\electron\dist\electron.exe"
$log = 'D:\Dev\tools\t3code-heal.log'
$taskName = 'T3Code Fork Heal After Close'

function Log($msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Tee-Object -FilePath $log -Append | Out-Null }
function Test-AppRunning { [bool](Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $electronExe }) }

# The install must never start against a live app: it hangs on the locked
# electron binary and leaves node_modules half-built. So the app has to be
# closed AND still closed after the grace period; a reopen in between (which
# stranded the 2026-10-03 heal) sends us back to waiting.
Log "heal task started; waiting for $electronExe to exit"
$deadline = (Get-Date).AddHours(48)
while ($true) {
  while ((Test-AppRunning) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 10 }
  if ((Get-Date) -ge $deadline) { Log "gave up waiting after 48h"; schtasks /delete /tn $taskName /f | Out-Null; exit 1 }
  Log "app closed; giving handles 15s to release"
  Start-Sleep -Seconds 15
  if (-not (Test-AppRunning)) { break }
  Log "app was reopened during the grace period; waiting for it to close again"
}

$env:PATH = "D:\Dev\tools\node-v24.18.0-win-x64;$env:USERPROFILE\.t3-bin;$env:USERPROFILE\.vite-plus\bin;$env:PATH"
$env:VP_NODE_MANAGER = 'no'
Set-Location $repo
Log "HEAD: $(git rev-parse --short HEAD) on $(git branch --show-current)"

Log "pnpm install starting"
# The purge flag lets pnpm rebuild node_modules without a TTY when the layout changed.
corepack pnpm install --config.confirmModulesPurge=false 2>&1 | Out-File -FilePath $log -Append
Log "pnpm install exit=$LASTEXITCODE"

if (-not (Test-Path $electronExe)) {
  Log "electron.exe missing after install; running electron install.js"
  Push-Location "$repo\apps\desktop\node_modules\electron"
  node install.js 2>&1 | Out-File -FilePath $log -Append
  Pop-Location
}
if (Test-Path $electronExe) { Log "electron: $(& $electronExe --version 2>&1)" } else { Log "ERROR: electron.exe still missing" }

# A failed build wipes apps\web\dist, so keep the old artifacts to put back.
$backup = 'D:\Dev\tools\t3code-heal-dist-backup'
$dists = 'apps\web\dist', 'apps\server\dist', 'apps\desktop\dist-electron'
Remove-Item -Recurse -Force $backup -ErrorAction SilentlyContinue
foreach ($d in $dists) {
  New-Item -ItemType Directory -Force (Split-Path "$backup\$d") | Out-Null
  Copy-Item -Recurse "$repo\$d" "$backup\$d"
}

$before = (Get-Item "$repo\apps\desktop\dist-electron\main.cjs").LastWriteTime
Log "build starting (main.cjs before: $before)"
corepack pnpm exec vp run --filter "./apps/*" --filter "./packages/*" build 2>&1 | Out-File -FilePath $log -Append
$buildExit = $LASTEXITCODE
$after = (Get-Item "$repo\apps\desktop\dist-electron\main.cjs").LastWriteTime
Log "build exit=$buildExit (main.cjs after: $after)"
if ($buildExit -ne 0 -or $after -eq $before) {
  Log "ERROR: build failed or produced nothing; restoring the previous artifacts and relaunching so the app is not stranded"
  foreach ($d in $dists) {
    Remove-Item -Recurse -Force "$repo\$d" -ErrorAction SilentlyContinue
    Copy-Item -Recurse "$backup\$d" "$repo\$d"
  }
}
Remove-Item -Recurse -Force $backup -ErrorAction SilentlyContinue

if (Test-Path $electronExe) {
  Log "relaunching app"
  Start-Process -FilePath $electronExe -ArgumentList 'dist-electron\main.cjs' -WorkingDirectory "$repo\apps\desktop"
} else {
  Log "ERROR: cannot relaunch, no electron binary"
}

schtasks /delete /tn $taskName /f | Out-File -FilePath $log -Append
Log "task deleted; done"
