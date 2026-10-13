# Foreground install + build + relaunch of the daily driver, for builds whose
# dependency install cannot run while the app holds electron.exe. The user
# closes the app, runs this in a terminal, and watches it; /build hands off to
# it (see .claude/commands/build.md). Output goes to the terminal and to
# D:\Dev\tools\t3code-rebuild.log, kept outside the worktree so it never shows
# up in git status.
#
#   pwsh -NoProfile -ExecutionPolicy Bypass -File D:\Dev\t3code\fork-tools\rebuild-after-close.ps1

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$electronDir = "$repo\apps\desktop\node_modules\electron"
$electronExe = "$electronDir\dist\electron.exe"
$log = 'D:\Dev\tools\t3code-rebuild.log'

function Log($msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Tee-Object -FilePath $log -Append }
function Test-AppRunning { [bool](Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $electronExe }) }

# The install must never start against a live app: it hangs on the locked
# electron binary and leaves node_modules half-built. No wait loop here on
# purpose; the person running this is the one who closes the app.
if (Test-AppRunning) {
  Log "T3 Code is still running ($electronExe). Close it, then run this script again."
  exit 1
}

$env:PATH = "D:\Dev\tools\node-v24.18.0-win-x64;$env:USERPROFILE\.t3-bin;$env:USERPROFILE\.vite-plus\bin;$env:PATH"
$env:VP_NODE_MANAGER = 'no'
Set-Location $repo
Log "rebuild started; HEAD: $(git rev-parse --short HEAD) on $(git branch --show-current)"

# --config.side-effects-cache=false: pnpm 11 hangs forever after the build
# scripts while writing its side-effects cache on this machine (2026-10-03 and
# 2026-10-13). --config.confirmModulesPurge=false lets pnpm rebuild
# node_modules without a TTY when the layout changed.
Log "pnpm install starting"
corepack pnpm install --config.confirmModulesPurge=false --config.side-effects-cache=false 2>&1 | Tee-Object -FilePath $log -Append
$installExit = $LASTEXITCODE
Log "pnpm install exit=$installExit"
if ($installExit -ne 0) {
  # A killed earlier install can leave a patched package half-applied; pnpm then
  # fails with ERR_PNPM_PATCH_FAILED and names the directory. Deleting that
  # node_modules\.pnpm\<pkg> folder and rerunning fixes it.
  Log "ERROR: install failed; nothing was built. Read the errors above, fix, and rerun. The app was not relaunched."
  exit 1
}

if (-not (Test-Path $electronExe)) {
  Log "electron.exe missing after install; running electron install.js"
  Push-Location $electronDir
  node install.js 2>&1 | Tee-Object -FilePath $log -Append
  Pop-Location
}
if (Test-Path $electronExe) { Log "electron: $(& $electronExe --version 2>&1)" } else { Log "ERROR: electron.exe still missing"; exit 1 }

# A failed build wipes apps\web\dist, so keep the old artifacts to put back.
$backup = 'D:\Dev\tools\t3code-rebuild-dist-backup'
$dists = 'apps\web\dist', 'apps\server\dist', 'apps\desktop\dist-electron'
Remove-Item -Recurse -Force $backup -ErrorAction SilentlyContinue
foreach ($d in $dists) {
  New-Item -ItemType Directory -Force (Split-Path "$backup\$d") | Out-Null
  Copy-Item -Recurse "$repo\$d" "$backup\$d"
}

$before = (Get-Item "$repo\apps\desktop\dist-electron\main.cjs").LastWriteTime
Log "build starting (main.cjs before: $before)"
corepack pnpm exec vp run --filter "./apps/*" --filter "./packages/*" build 2>&1 | Tee-Object -FilePath $log -Append
$buildExit = $LASTEXITCODE
$after = (Get-Item "$repo\apps\desktop\dist-electron\main.cjs").LastWriteTime
Log "build exit=$buildExit (main.cjs after: $after)"
$buildOk = ($buildExit -eq 0) -and ($after -ne $before)
if (-not $buildOk) {
  Log "ERROR: build failed or produced nothing; restoring the previous artifacts so the app still starts"
  foreach ($d in $dists) {
    Remove-Item -Recurse -Force "$repo\$d" -ErrorAction SilentlyContinue
    Copy-Item -Recurse "$backup\$d" "$repo\$d"
  }
}
Remove-Item -Recurse -Force $backup -ErrorAction SilentlyContinue

Log "relaunching app"
Start-Process -FilePath $electronExe -ArgumentList 'dist-electron\main.cjs' -WorkingDirectory "$repo\apps\desktop"
if ($buildOk) { Log "done: the app is running the new build" } else { Log "done: the app is running the PREVIOUS build; read the build errors above"; exit 1 }
