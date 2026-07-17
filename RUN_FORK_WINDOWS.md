# Running this t3code fork on Windows (from source)

`npx t3@latest` runs the **published** build and will NOT include the local Windows
auth fix (see `CLAUDE_WINDOWS_AUTH_FIX.md`). To exercise the fork you must run from
source. Two host prerequisites bite on Windows:

## 1. Vite+ (`vp`) toolchain

t3code's dev/build scripts run through `vp`, not plain npm/pnpm. Install once:

```powershell
irm https://vite.plus/ps1 | iex
```

Non-interactive (skips the "manage Node.js versions" prompt):

```powershell
$env:VP_NODE_MANAGER='no'; $env:CI='true'; irm https://vite.plus/ps1 | iex
```

Installs to `%USERPROFILE%\.vite-plus\bin\vp.exe`. Restart the terminal so it lands on PATH.

## 2. Node >= 24.13

`package.json` engines want `node ^24.13.1`. The dev-runner
(`scripts/dev-runner.ts`) gates its entire CLI behind `if (import.meta.main)`, which
is `undefined` before Node **24.2** — so on older Node the dev command exits 0 having
done nothing (ports never open, no error). System Node here is 24.1.0.

To avoid touching global Node, use an **isolated portable Node** just for t3code:

```powershell
# one-time: download + extract portable Node
$ver='v24.18.0'
Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile "D:\Dev\tools\node-$ver-win-x64.zip"
Expand-Archive "D:\Dev\tools\node-$ver-win-x64.zip" -DestinationPath D:\Dev\tools -Force
```

## Launch (daily driver — DESKTOP app)

```powershell
D:\Dev\t3code\start-t3code-desktop.ps1     # or Start Menu -> "T3 Code (fork)"
```

Native Electron window ("T3 Code (Alpha)"), spawns its own embedded server on a
dynamic port, authenticates its own window automatically — **no pairing tokens**.
Shares the `~\.t3\userdata` store with the standalone server variant below (don't
run both at once). The installed upstream T3 Code (winget, in
`AppData\Local\Programs\t3code`) is the UNPATCHED version — avoid it, or uninstall
(`winget uninstall T3Tools.T3Code`); its codex-default bug re-mints broken bindings
on any project it creates.

## Launch (alternative — headless server + browser)

```powershell
D:\Dev\t3code\start-t3code.ps1        # serves API + web UI on http://localhost:13773
```

One process, one origin (`:13773`), survives independent of any dev tooling. On first
run (or after wiping `~\.t3\userdata`) the console prints a `pairingUrl` — open it
once (tokens are single-use, see below). Rebuild after changing/pulling code:

```powershell
# NOTE: `corepack pnpm build` at the repo root silently builds NOTHING on Windows —
# the script's single-quoted filters ('./apps/*') reach vp literally via cmd.exe and
# match no packages (exit 0 regardless). Pass the filters yourself:
$env:PATH = "D:\Dev\tools\node-v24.18.0-win-x64;$env:USERPROFILE\.vite-plus\bin;$env:PATH"
cd D:\Dev\t3code
corepack pnpm exec vp run --filter "./apps/*" --filter "./packages/*" build
```

Note: dev mode (`:5733`) and production (`:13773`) are different origins AND
different auth stores (`~\.t3\dev` vs `~\.t3\userdata`) — a browser paired with one
is not paired with the other.

## Launch (dev, hot reload)

```powershell
$env:PATH = "D:\Dev\tools\node-v24.18.0-win-x64;$env:USERPROFILE\.vite-plus\bin;$env:PATH"
cd D:\Dev\t3code
$env:VP_NODE_MANAGER='no'
corepack pnpm dev
```

- Web UI: **http://localhost:5733** (auto-opens)
- Server: http://localhost:13773
- Ports shift by an offset if taken; set `T3CODE_DEV_INSTANCE=<name>` for a fixed alt set.

## Pairing (browser auth) gotchas

The web UI demands a pairing token. Three traps, all learned the hard way:

- **Tokens are single-use.** The `/pair#token=...` page consumes the token on load.
  A second tab, a refresh, or a re-click sees "Invalid pairing token". Open the
  pairing URL exactly once; the browser then holds a long-lived session cookie.
- **Use the URL the _running server_ prints.** The server logs
  `pairingUrl: http://localhost:5733/pair#token=...` whenever an unpaired client
  knocks — always take the newest one from the server console.
- **CLI minting must target the dev store.** The dev server keeps auth state in
  `~\.t3\dev\`; the CLI defaults to `~\.t3\userdata\`. To mint tokens for the dev
  server: set `VITE_DEV_SERVER_URL=http://localhost:5733` (plus the portable-Node
  PATH) and run, from `apps/server`:
  `node src/bin.ts auth pairing create --ttl 1h --json` — the `credential` field is
  the token.

## Verify the auth fix

Open the Claude tab (or Settings -> Providers -> Claude). With the fix it reads
**authenticated** as your claude.ai account instead of "Could not verify Claude
authentication status." Before the fix, the same screen showed Claude as installed but
unauthenticated because the SDK could not spawn the npm `claude` shim by bare name.
