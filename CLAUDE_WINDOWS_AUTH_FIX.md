# Local fix: Claude "could not verify authentication status" on Windows

## Symptom

On Windows with Claude Code installed via **npm** (`npm i -g @anthropic-ai/claude-code`),
the Claude provider always shows as unauthenticated ("Could not verify Claude
authentication status from initialization result") even though `claude` works and is
signed in. Related upstream issue: pingdotgg/t3code#2653 (its `apiKeySource: "none"`
theory is not what happens here — the probe never gets far enough to see an init event).

## Root cause

`ClaudeProvider.probeClaudeCapabilities` and `ClaudeAdapter` pass the configured
`binaryPath` (default: bare `"claude"`) straight to the Agent SDK as
`options.pathToClaudeCodeExecutable`. The SDK treats that value as a **literal file
path** (stat + spawn, no PATH search). Reproduced with a minimal SDK script:

- `pathToClaudeCodeExecutable: "claude"` → fails in ~7 ms:
  `Claude Code native binary not found at claude.`
- option omitted (SDK default) → init OK in ~1.2 s, full account info returned
- `...\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` → init OK in ~1.1 s

On macOS/Linux the bare name happens to work because `spawn` falls back to a PATH
lookup there. On Windows, npm exposes `claude` only as `.ps1`/`.cmd` shims, which
neither the SDK's stat nor `CreateProcess` will resolve — so every SDK-based code path
(capability probe **and** real chat sessions) fails before authentication is ever
checked. The version probe works because it goes through `resolveSpawnCommand`, which
shell-wraps `.cmd` files — that mismatch is why t3code reports "installed" but
"unauthenticated".

## Fix

`apps/server/src/provider/Drivers/ClaudeSdkExecutable.ts` —
`resolveClaudeSdkExecutablePath()`: on Windows, resolve a bare command name by
scanning PATH for (in order) a native `<name>.exe`, or an npm `.cmd`/`.ps1` shim whose
adjacent package install contains `node_modules/@anthropic-ai/claude-code/bin/claude.exe`
(current npm layout) or `cli.js` (older layout). Explicit paths and non-Windows
platforms pass through untouched, as does a bare name nothing on PATH matches (so the
SDK's own error reporting is preserved).

Wired into both SDK call sites:

- `ClaudeProvider.ts` — capabilities probe (`pathToClaudeCodeExecutable`)
- `ClaudeAdapter.ts` — session spawn (`claudeBinaryPath`)

`ClaudeTextGeneration.ts` needs no change (it uses `resolveSpawnCommand`).

Tests: `ClaudeSdkExecutable.test.ts`.

## Validation

- Minimal SDK repro before/after (see timings above) on Windows 11, Claude Code via
  npm, claude.ai OAuth subscription (no API key).
- `vitest` on the new resolver tests (6/6) + existing `ClaudeAdapter` suite (59/59);
  `ProviderRegistry` has 16 pre-existing Windows failures identical with and without
  the change (cmd.exe caret-escaped `--version` args vs literal mock expectations).
  `tsgo --noEmit` clean.
- **Production-path A/B** via a scratch harness calling the real
  `checkClaudeProviderStatus` + `probeClaudeCapabilities` (Claude Code CLI v2.1.212):
  - baseline: `status: "warning"`, `auth: { status: "unknown" }`,
    message `"Could not verify Claude authentication status from initialization result."`,
    0 slash commands
  - with fix: `status: "ready"`, `auth: { status: "authenticated", type: "Claude Pro" }`
    with account email, 49 slash commands
