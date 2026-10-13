# Desktop dictation: run log

Spec: `desktop-dictation.md`. This file holds status, decisions and how the
work is going. Workers read the spec, not this.

## Status (updated 2026-10-13, wave 1 running)

| Package                  | Runs as  | Model | Branch / worktree | State       | Waiting on |
| ------------------------ | -------- | ----- | ----------------- | ----------- | ---------- |
| 0 Spike                  | subagent | Opus  | `dictation-spike` | sent back   | -          |
| 1 Server service         | -        | -     | -                 | not started | -          |
| 2 Composer button        | -        | -     | -                 | not started | -          |
| 3 Cleanup and dictionary | -        | -     | -                 | not started | -          |
| 4 Settings section       | -        | -     | -                 | not started | -          |
| 5 Phone pass and docs    | -        | -     | -                 | not started | -          |

Decisions this wave:

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
- Open for the owner: the ~6 s cold load means the first dictation after the
  10-minute idle unload takes ~7 s, not ~2 s. Options: accept, or lengthen
  the idle window (e.g. 60 min). Not blocking phase 1.

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
- **Memory?** Model stays loaded, unloads after 10 minutes idle.
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
