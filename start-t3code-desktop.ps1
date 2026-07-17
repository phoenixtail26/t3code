# Daily-driver launcher for the patched t3code fork — DESKTOP app (Electron).
# Spawns its own embedded server (dynamic port, no pairing needed) against the
# shared ~\.t3\userdata store. See RUN_FORK_WINDOWS.md. Rebuild after changes:
#   corepack pnpm exec vp run --filter "./apps/*" --filter "./packages/*" build

$nodeDir = "D:\Dev\tools\node-v24.18.0-win-x64"
if (-not (Test-Path "$nodeDir\node.exe")) {
	Write-Error "Portable Node not found at $nodeDir (see RUN_FORK_WINDOWS.md)."
	exit 1
}
if (-not (Test-Path "$PSScriptRoot\apps\desktop\dist-electron\main.cjs")) {
	Write-Error "No desktop build found. Run the build command in this script's header first."
	exit 1
}

$env:PATH = "$nodeDir;$env:USERPROFILE\.vite-plus\bin;$env:PATH"
$env:VP_NODE_MANAGER = 'no'

Set-Location "$PSScriptRoot\apps\desktop"
corepack pnpm start
