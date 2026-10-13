# Desktop dictation (voice-to-text in the composer)

Status: decided 2026-10-13, not started. Roadmap item 11 in `FORK_ROADMAP.md`.

## Goal

Press a button or shortcut, speak, stop, and the words land at the cursor in
the chat composer. Works in the desktop app and the phone PWA from one web
implementation, with transcription done locally on the environment server.

## Why not upstream's #14882

`feat(voice): add configurable local voice transcription` is +18.6k lines: a
71-model catalog, GPU selection, streaming previews, LLM cleanup through every
provider, and dictation in PR/diff/preview inputs. It edits 89 upstream files,
including `ChatComposer.tsx` (+270) and `ChatView.tsx`, and already conflicts
with `upstream/main` in ~30 files. Carrying it would break every
`/sync-upstream`. Fetched locally as branch `pr-14882` for reference. Worth
copying from it: the engine choice (`transcribe-cpp`), server-side
transcription, and running the model in a child process.

## Decisions

Each entry is the question, the answer, and the reason.

### Scope

- **Clients?** Web client only; desktop and the phone PWA get it for free.
  Native mobile app and app.t3.codes-over-relay are out of scope. The phone
  already reaches the server over Tailscale HTTPS, which browsers require for
  microphone access.
- **Where does transcription run?** On the environment server. Clients only
  record and upload. One implementation serves every client; the desktop shell
  would leave the phone out.
- **Engine?** Local model only via `transcribe-cpp` (MIT, prebuilt
  `win32-x64-cpu-vulkan`, loads GGUF). No cloud/BYOK option, not even as a
  fallback. Offline, no key, no audio leaves the machine. A cloud engine can be
  a second implementation behind the same service later.
- **Language?** English only, so the English Parakeet TDT 0.6B model (best
  speed/accuracy). Swapping models later changes no code shape.
- **Batch or streaming?** Batch: speak, stop, text appears ~1 s later.
  Streaming previews are a nice-to-have for later, probably not needed; they
  were the bulk of #14882's complexity.
- **What happens to the text?** Inserted at the cursor in the Tiptap composer
  (an editor command, not a value set). Never auto-sent. Auto-send is a
  possible later option; its risk is a misheard prompt reaching an agent.
- **Which inputs?** The chat composer only (existing thread and new thread).
  Not PR review forms, diff comments or preview annotations; each extra input
  is another upstream file to keep in sync.
- **Start/stop?** Toggle: mic button or shortcut starts, the same stops and
  transcribes, Escape cancels and discards. No hold-to-talk in v1 (no key to
  hold on the phone).
- **If upstream ships dictation?** Delete ours and take theirs, even if
  heavier. Two mic buttons and a conflict surface are worse. Keeping ours in
  new files makes removal a folder delete plus its one-line mounts.

### Feedback

- **Recording feedback?** The mic button becomes a red recording pill with a
  live level meter (a few bars from the mic's real loudness, ~15 updates/s,
  only while the mic is open) and an elapsed timer ticking once a second.
  While transcribing, a short indeterminate progress bar. Both stop drawing
  when the state ends, which keeps the AGENTS.md "no continuously repainting
  animations" rule: it targets idle animations, not activity-driven ones. The
  composer stays editable throughout. Same pill on the phone PWA.
- **Failure handling?** Toast with the reason, audio discarded. No retry with
  the same audio; re-dictating is cheap and retry adds state.

### Text processing

- **Filler cleanup?** Rule-based on the server after transcription: a fixed
  list (um, uh, er, ah, "you know", doubled words like "the the"), on by
  default with a settings toggle. No LLM pass: it adds latency, a provider
  dependency and a per-provider decision. Parakeet already drops most fillers.
  **To be validated** in use; an LLM pass is the fallback if rules are not
  enough.
- **Custom dictionary mechanics?** A correction list applied after
  transcription: `heard => wanted`, case-insensitive, whole-word. Works with
  any model, so Parakeet stays. Whisper-style prompt biasing was rejected
  because it would force a slower, less accurate model. Downside: a mishearing
  must be noticed once and added.
- **Dictionary scope and editing?** One global list in Settings → Voice (fork
  settings panel), plain text, one entry per line. Per-project lists later if
  vocab conflicts.
- **Testability?** Settings → Voice shows the last transcription raw vs
  cleaned, so the filler/dictionary rules can be judged without logs. It is
  the data needed to decide on an LLM pass later.

### Server behaviour

- **Model download?** No setup step. First mic click with no model present
  starts the ~600 MB download; the button shows progress; mic works once it
  lands. Settings → Voice shows model state and a "Remove model" button
  (the reverse state). Model files live under T3 home.
- **Memory?** Model stays loaded after first use, unloads after 10 minutes
  idle (frees ~1-2 GB). Next dictation after idle pays a 1-2 s reload.
- **Concurrency?** Transcriptions queue FIFO and run one at a time; each
  composer's pill stays in "Transcribing…" until its turn. No busy error. The
  user runs many threads, so overlapping requests are a real workload, but
  each takes ~1 s and loading the model per request would multiply memory.
- **Recording cap?** Auto-stop at 5 minutes and transcribe what was captured.
- **Transport?** Audio uploads as 16 kHz mono PCM over an HTTP POST to a
  fork-owned route, like attachments. 5 minutes is ~10 MB, which must not go
  over the WebSocket where it would block every other message.

### Client behaviour

- **Recording while switching threads?** One recording at a time. Switching
  threads mid-recording stops it and transcribes into the originating
  thread's draft. Several threads means stop, switch, start. Letting a
  recording follow the user needs a global indicator and routing rules.
- **Shortcut?** One toggle keybinding, default `mod+shift+m` (verify no
  collision before building), rebindable in the existing keybindings
  settings and listed in the command palette.

## Shape (expected, not yet verified)

Roughly 400-600 lines, almost all in fork-owned files:
`apps/server/src/speech/` (service, HTTP route, filler/dictionary rules,
model download, child-process worker), `apps/web/src/speech/` (recorder,
level meter, upload, composer insertion, pill), a `settings/fork` panel,
`Schema.optionalKey` fields in settings. Upstream files get one-line mounts:
the button in `ChatComposer.tsx`, a route spread in `server.ts`, the
keybinding entry.

## Before building

1. Spike: confirm `transcribe-cpp`'s Windows binary loads under portable Node
   24 and the Electron-bundled server, and that `/build`'s license manifest
   accepts it (see memory: fork-only deps without LICENSE break the web
   build). Fallback if it does not load: run whisper.cpp's prebuilt
   `whisper-cli.exe` as a subprocess.
2. Run the upstream drift check (`FORK_REMOTES.md`); g3code was 839 commits
   behind on 2026-10-13, so sync first.
