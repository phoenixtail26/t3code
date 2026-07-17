# Daily-driver launcher for the patched t3code fork (see RUN_FORK_WINDOWS.md).
# Runs the production build: single server process serving API + web UI, and
# auto-opens a paired browser tab. Rebuild after pulling/changing code with:
#   corepack pnpm build   (with the same PATH setup this script uses)
param(
	[int]$Port = 13773
)

$nodeDir = "D:\Dev\tools\node-v24.18.0-win-x64"
if (-not (Test-Path "$nodeDir\node.exe")) {
	Write-Error "Portable Node not found at $nodeDir (see RUN_FORK_WINDOWS.md)."
	exit 1
}
if (-not (Test-Path "$PSScriptRoot\apps\server\dist\bin.mjs")) {
	Write-Error "No production build found. Run 'corepack pnpm build' in $PSScriptRoot first."
	exit 1
}

$env:PATH = "$nodeDir;$env:USERPROFILE\.vite-plus\bin;$env:PATH"
$env:VP_NODE_MANAGER = 'no'
$env:T3CODE_PORT = "$Port"

Set-Location $PSScriptRoot
corepack pnpm start
