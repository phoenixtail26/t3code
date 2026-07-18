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
# Start Menu -> "T3 Code (fork)"  (preferred: launches electron.exe directly, NO console window)
# or, from a terminal:
D:\Dev\t3code\start-t3code-desktop.ps1
```

The Start Menu shortcut targets
`apps\desktop\node_modules\electron\dist\electron.exe dist-electron\main.cjs`
(cwd `apps\desktop`) — the exact command the launcher script reduces to on
Windows, minus the PowerShell/Windows Terminal host window that would otherwise
have to stay open (WT ignores `-WindowStyle Hidden`). The pnpm-linked electron
path stays valid across electron version bumps.

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

## Phone access + notifications (setup checklist)

Rationale and decisions live in `FORK_ORCHESTRATOR.md` (roadmap #2). Steps that
need a human sign-in are marked. Order matters — do Tailscale before pairing so
the phone pairs against the durable HTTPS URL.

Completed on this machine 2026-07-18; the values below are the live ones.

1. **Tailscale on the PC** (sign-in): `winget install tailscale.tailscale`, sign
   in with the Google account. Install Tailscale on the phone and sign in with
   the SAME account — check `tailscale status` lists the phone as a peer, or
   nothing will reach the PC. Here: PC `viki` = 100.85.106.78, Pixel 9 =
   100.126.137.78, tailnet `tailae8de0.ts.net`.
2. **Enable HTTPS certificates** for the tailnet at
   <https://login.tailscale.com/admin/dns> → **HTTPS Certificates** → Enable.
   Verify with `tailscale status --json` → `CertDomains` non-empty. Without
   this the Tailscale HTTPS row cannot issue a certificate.
3. **RESTART the desktop app after installing Tailscale.** t3code spawns
   `tailscale.exe` by bare name, so it only finds it if the app's process
   inherited the PATH entry the installer added (`C:\Program Files\Tailscale\`,
   machine PATH). An app started before the install — or relaunched from a
   stale Explorer — shows the Tailscale row with NO switch and the message
   "Start Tailscale to set up HTTPS access through MagicDNS", which reads like
   a missing feature. Relaunch from a process with a refreshed PATH.
4. **Expose the backend**: desktop app → Settings → Connections → **This
   environment** section (NOT "Manage Local Backend" as upstream docs say) →
   **Network access** on. It restarts the backend off loopback. Expand the
   endpoint list (`+N`) and make the Tailscale endpoint the default — the
   first-listed endpoint is often a useless virtual adapter (`10.5.0.2`,
   Docker/WSL).
5. **Tailscale HTTPS row** → switch on → confirm "Set up Tailscale HTTPS?".
   Verify with `tailscale serve status`: expect
   `https://viki.tailae8de0.ts.net (tailnet only) |-- / proxy
http://127.0.0.1:3773`, and a 200 from that URL.
6. **Pair the phone**: Authorized clients → **Create link**, label it (e.g.
   "Pixel 9"), keep the **Standard** permission preset — the four checked
   scopes let the phone drive threads; leave **Manage access** and **Manage
   relay** off so a lost phone cannot mint credentials for anything else.
   - **Do not scan the QR with the camera app.** It opens an in-app browser,
     and the session cookie lands _there_ — reopening in Chrome then shows the
     pairing prompt again with the token already spent.
   - Instead: open **Chrome** on the phone, go to
     `https://viki.tailae8de0.ts.net`, and type the 12-character token into the
     prompt. Mint tokens headlessly with (from `apps/server`, portable-Node
     PATH, `T3CODE_HOME=~\.t3`):
     `node src/bin.ts auth pairing create --ttl 1h --label "Pixel 9" --json`
   - Then Chrome menu → **Add to Home screen** for the PWA. Pairing leaves a
     long-lived cookie in THAT browser; the home-screen icon is the durable
     way back in.
7. **Notifications**: pick a LONG RANDOM ntfy topic name (the topic URL is the
   only credential — anyone who knows it can read your notifications), install
   the ntfy app on the phone, subscribe to that topic, then set in the settings
   file (`~\.t3\userdata\settings.json`, or dev store when running dev mode):

   ```json
   "pushNotifications": {
     "topicUrl": "https://ntfy.sh/t3code-<long-random-suffix>",
     "publicBaseUrl": "https://machine.tailnet.ts.net",
     "notifyOnApproval": true,
     "notifyOnInput": true,
     "notifyOnFailure": true,
     "notifyOnCompletion": true
   }
   ```

   Empty `topicUrl` disables the feature entirely (nothing leaves the machine).
   Notifications fire on awareness phase transitions and deep-link back to the
   thread. For full privacy, self-host ntfy on the tailnet and point
   `topicUrl` at it.

## Notification branding on Windows (toast says "Electron")

Toast delivery works regardless, but Windows attributes each toast to an
**AppUserModelID**, not to the window title or the shortcut icon. The app calls
`setAppUserModelId("com.t3tools.t3code")`; running unpackaged from
`electron.exe` with no matching registration, Windows falls back to the binary's
own identity and shows "Electron" with the Electron icon.

Fix (per user, no admin, reversible) — register the identity once:

```powershell
$key = "HKCU:\SOFTWARE\Classes\AppUserModelId\com.t3tools.t3code"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name DisplayName -Value "T3 Code (fork)" -Type String
Set-ItemProperty -Path $key -Name IconUri `
  -Value "D:\Dev\t3code\apps\desktop\resources\icon.png" -Type String
```

Restart the app afterwards; Windows resolves the identity at startup. Remove the
key to undo. Stamping `System.AppUserModel.ID` onto the Start Menu shortcut via
`IPropertyStore` is the other documented route, but the write did not read back
here, so the registry entry is the one to rely on.

A packaged build (`pnpm dist:desktop:win`) sets this up properly on install and
makes the whole issue moot.

## Verify the auth fix

Open the Claude tab (or Settings -> Providers -> Claude). With the fix it reads
**authenticated** as your claude.ai account instead of "Could not verify Claude
authentication status." Before the fix, the same screen showed Claude as installed but
unauthenticated because the SDK could not spawn the npm `claude` shim by bare name.
