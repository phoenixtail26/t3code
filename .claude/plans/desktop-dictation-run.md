# Desktop dictation: run log

Spec: `desktop-dictation.md`. This file holds status, decisions and how the
work is going. Workers read the spec, not this.

## Status (updated 2026-10-13, overnight run on branch `dictation`)

| Package                  | Runs as  | Model | Branch / worktree          | State               | Waiting on                |
| ------------------------ | -------- | ----- | -------------------------- | ------------------- | ------------------------- |
| 0 Spike                  | subagent | Opus  | `dictation-spike`          | merged `fe1000b024` | -                         |
| 1 Server service         | subagent | Opus  | `dictation` @ `50a5da8098` | done, reviewed      | -                         |
| 2 Composer button        | subagent | Fable | `dictation` @ `4ca322a22a` | done, reviewed      | owner: mic proof (Done 1) |
| 3 Cleanup and dictionary | subagent | Opus  | `dictation`                | building            | -                         |
| 4 Settings section       | -        | -     | -                          | not started         | -                         |
| 5 Phone pass and docs    | -        | -     | -                          | not started         | -                         |

Overnight run 2026-10-13: branch `dictation` cut from `g3code` @
`6d957479d1` in `~/.t3/worktrees/t3code/dictation`. Base gates green except
`serverSettings.test.ts` > "reloads when a dangling settings link gets its
destination", a pre-existing Windows symlink failure (242/243); ignore it.
Unattended proof substitutes: Done 1-3 need a human voice and are left for
the owner; workers prove the same paths with a synthesized WAV through the
route and recorder code, and unit tests. Phase 6 phone pass is blocked by
design. Each worker starts and stops its own `pnpm dev:desktop` by PID.

Decisions this wave:

- 2026-10-13 phase 3 review: sent back once (palette item was a 14-line
  fork block in `CommandPalette.tsx`; now `dictation/paletteItem.tsx` with a
  one-line push), fixed in `4ca322a22a`, re-accepted. Escape while
  recording cancels the recording and is consumed; a dialog open at the same
  time closes on the next press. Kept as is: cancelling the mic first is the
  safer order.

- 2026-10-13 phase 3 (composer) worker choices, accepted pending review:
  toggle is a no-op while downloading or transcribing; leaving the thread
  during a download abandons the pending start; recordings under 0.25 s
  are dropped; ScriptProcessorNode (not AudioWorklet) for capture;
  `./state/environment-http-auth` subpath export added to client-runtime;
  relay/DPoP connections get the auth helper's error. UI proof blocked:
  the T3 preview tools refuse subagents ("calling provider no longer owns
  an active thread run"), so there is no `dictation-desktop.mp4`; the
  owner records Done 1 in the morning. Incident: the worker ran a bare
  `bin.ts pair` which minted a 5-minute token in the live store; it
  expired unused.

- 2026-10-13 phase 2 review: sent back once (remove must cancel a pending
  download; proof lacked percent), fixed in `50a5da8098`, re-accepted.
  `POST /api/dictation/model` (start or join the download) is an addition to
  the spec's route list; phase 3 uses it for first-click download.

- 2026-10-13 phase 2 (server) worker choices, accepted by the orchestrator:
  `POST /api/dictation/model` starts or joins the download and waits, the
  client polls status for percent; `transcribe` downloads a missing model
  first; remove waits its FIFO turn and cancels a running download; "ready"
  means the file is at the pinned size, SHA-256 checked once at download;
  engine backend auto (Vulkan0 here); errors are `{ error }` with
  400/413/500/502. Measured: download 70.6 s, first transcribe 1.37 s
  headless / 7.0 s under Electron, warm 0.06-0.13 s. Packaged `server.asar`:
  the engine DLL cannot load from inside the archive; the worker points
  `TRANSCRIBE_LIBRARY` at `server.asar.unpacked` and that was proven in
  packaged Electron 44. The single-executable `__dictation-worker` path is
  untested. Workers cannot write report files under `~/.t3/dev` (harness
  block), so reports are inline in this thread only.

- 2026-10-13: upstream drift re-checked at wave start: 3 commits behind,
  dry-run merge clean. The sync pre-condition is satisfied for building; the
  integrator runs `/sync-upstream` before merging the spike branch so the
  worker's base stays fixed while it builds.
- 2026-10-13: spike verdict: transcribe-cpp works on this machine (exact
  transcript; warm transcribe 89 ms Vulkan, 255 ms CPU; cold load ~6 s).
  Approved for the spike branch: `allowBuilds: koffi: false` in
  `pnpm-workspace.yaml`; `koffi` and `@koromix/` added to the external
  CLI prefixes with `transcribe-cpp`; the external-packages test expected
  list updated. The full desktop artifact could not be built in the worktree
  (Rust missing); only the external staging and license manifest were
  proven.
- 2026-10-13: review accepted the spike branch (`8c8917f167`) with no
  changes. Phase 1 verification item added: prove the engine loads from
  inside the packaged `server.asar` (`ELECTRON_RUN_AS_NODE`); the spike
  only proved the files are staged.
- 2026-10-13: trial merge passed: `upstream/main` (3 commits) then
  `dictation-spike` merge clean into a scratch worktree
  (`~/.t3/worktrees/t3code/dictation-integrate`, branch
  `integrate-dictation-wave1` @ `3a7f063841`); lint, typecheck, test
  19/19 pass; `import('transcribe-cpp')` loads, version 0.2.4, backends
  Vulkan (RTX 3070, AMD iGPU) and CPU. Note for phase 1: the package is
  ESM-only with no `require` export, so the worker must `import()` it.
  Upstream touched `.github/workflows`, so the push needs
  `gh auth refresh -s workflow` first. Waiting on the owner's go for the
  real sync and merge into `g3code`.
- 2026-10-13: owner decided: model idle unload after 60 minutes, not 10,
  because the ~6 s cold load would make the first dictation after a short
  idle take ~7 s. Owner gave go; `g3code` fast-forwarded to `fe1000b024` (upstream sync
  `e7f0b57f49` + spike). Main checkout `node_modules` is stale until the
  next `vp i` / `/build`.

## Decisions

Grilled 2026-10-13 (three rounds). Question, answer, reason.

### Why not upstream's #14882

`feat(voice): add configurable local voice transcription` is +18.6k lines: a
71-model catalog, GPU selection, streaming previews, LLM cleanup through every
provider, and dictation in PR/diff/preview inputs. It edits 89 upstream files,
including `ChatComposer.tsx` (+270) and `ChatView.tsx`, and already conflicts
with `upstream/main` in ~30 files, so carrying it would break every sync.
Fetched locally as branch `pr-14882` for reference. Worth copying: the engine
(`transcribe-cpp`), server-side transcription, model in a child process.

### Scope

- **Clients?** Web only; desktop and the phone PWA get it for free. Native
  mobile and app.t3.codes-over-relay are out. The phone already reaches the
  server over Tailscale HTTPS, which browsers require for the microphone.
- **Where does transcription run?** On the environment server; clients only
  record and upload. One implementation serves every client.
- **Engine?** Local only, `transcribe-cpp` (MIT, prebuilt
  `win32-x64-cpu-vulkan`, loads GGUF). No cloud/BYOK, not even as fallback:
  offline, no key, no audio leaves the machine. A cloud engine could be a
  second implementation behind the same service later.
- **Language?** English only, so English Parakeet TDT 0.6B. Swapping models
  later changes no code shape.
- **Batch or streaming?** Batch. Streaming previews are a nice-to-have for
  later, probably not needed; they were the bulk of #14882's complexity.
- **What happens to the text?** Inserted at the cursor, never auto-sent.
  Auto-send is a possible later option; its risk is a misheard prompt
  reaching an agent.
- **Which inputs?** The chat composer only. Every extra input is another
  upstream file to keep in sync.
- **Start/stop?** Toggle plus Escape to cancel. No hold-to-talk in v1: no key
  to hold on the phone.
- **If upstream ships dictation?** Delete ours, take theirs, even if heavier.

### Feedback

- **Recording feedback?** Live level meter from real mic loudness, ~15
  updates/s, only while recording; elapsed timer at 1 Hz; indeterminate bar
  while transcribing. Activity-driven drawing that stops with the activity
  keeps the AGENTS.md "no continuously repainting animations" rule, which
  targets idle animations. The user asked for something more active than a
  static label.
- **Failure handling?** Toast with reason, audio discarded. No retry button;
  re-dictating is cheap.

### Text processing

- **Filler cleanup?** Rule-based on the server, on by default with a toggle.
  No LLM pass (latency, provider dependency, per-provider decision). Parakeet
  already drops most fillers. **To be validated in use**; an LLM pass is the
  fallback.
- **Dictionary mechanics?** Post-transcription correction list, `heard =>
wanted`, case-insensitive, whole-word. Works with any model so Parakeet
  stays; Whisper prompt biasing would force a slower, less accurate model.
- **Dictionary scope?** One global list, plain text in Settings. Per-project
  later if vocab conflicts.
- **Where in Settings?** Grilled as "Settings → Voice" on the assumption of a
  fork settings panel. None exists: fork settings are sections mounted with
  one line in upstream pages, and a new page touches 4-5 upstream files. So:
  a "Voice" section on the Chat settings page (2026-10-13, agent decision
  from the mount survey; owner can overrule for a dedicated page).
- **Testability?** Settings shows the last transcription raw vs cleaned, the
  data needed to judge the rules and decide on an LLM pass later.

### Server behaviour

- **Model download?** No setup step; first mic click downloads (~600 MB) with
  progress on the button. Settings shows model state and a Remove button.
- **Memory?** Model stays loaded, unloads after 60 minutes idle (was 10;
  raised 2026-10-13 after the spike measured a ~6 s cold load).
- **Concurrency?** FIFO queue, one at a time, no busy error. The user runs
  many threads so overlapping requests are a real workload; each takes ~1 s
  and loading the model per request would multiply memory. (Overturned the
  first proposal of a busy error.)
- **Recording cap?** 5 minutes, auto-stop and transcribe.
- **Transport?** HTTP POST of 16 kHz mono PCM to a fork route. 5 minutes is
  ~10 MB and must not go over the WebSocket.

### Client behaviour

- **Recording while switching threads?** One recording at a time; switching
  stops it and the text lands in the originating thread's draft.
- **Shortcut?** One toggle keybinding, rebindable, in the command palette.
  Grilled default was `mod+shift+m`; it is taken by `modelPicker.toggle`,
  so the default is `mod+shift+u` (free as of 2026-10-13).

## Handoffs

None yet.
