# Dictation: speak into the chat composer

Run log, status and the full decision record: `desktop-dictation-run.md`.

## Sources

- The decision list in `desktop-dictation-run.md` (grilled 2026-10-13). It
  is the authority on scope and behaviour.
- `transcribe-cpp` 0.2.4 (MIT, `github.com/handy-computer/transcribe.cpp`)
  for the engine API and model format. Upstream PR #14882 (local branch
  `pr-14882`) shows a working use of it, in particular
  `apps/server/src/speech/native.ts` for loading the module and chunking long
  audio. Copy patterns, not files.
- Fork mount conventions: `AGENTS.md` section "Keep fork code out of upstream
  files"; precedents `apps/server/src/fork/http.ts`,
  `apps/web/src/components/settings/fork/ForkSettings.tsx`.
- No reference recording exists for "good enough transcription". The judge is
  the owner dictating real prompts and reading the raw vs cleaned preview in
  settings.

## Out of scope

- Native mobile app and app.t3.codes over the relay: the phone uses the PWA
  over Tailscale HTTPS, which the web client covers.
- Cloud or BYOK transcription: local only; a second engine behind the same
  service is a later feature.
- Streaming previews while speaking: nice-to-have, probably unneeded; batch
  covers prompt dictation.
- Languages other than English: the model is English Parakeet; swapping the
  model later changes no code shape.
- Auto-send after transcription: the user reviews and sends.
- A mic button in PR review forms, diff comments, preview annotations: each
  is another upstream file to keep in sync. The shortcut reaches them anyway
  (see the focused-field bullet under Web).
- Hold-to-talk: no key to hold on the phone; toggle only.
- LLM cleanup of the transcript: rule-based cleanup first; revisit only if
  the raw vs cleaned preview shows rules are not enough.
- Retry with the same audio after a failure: re-dictating is cheap.
- Per-project dictionaries: one global list until vocab conflicts appear.
- Carrying upstream PR #14882: +18.6k lines across 89 upstream files, already
  conflicting with `upstream/main`; it would break every `/sync-upstream`.
  If upstream ships dictation, delete this feature and take theirs.

## Why the current thing is wrong

T3 Code has no voice input on desktop or web. Upstream's only shipped voice
input is iPhone-native (`352710d497`), and the owner's phone is a Pixel. The
only way to dictate today is Windows voice typing or a third-party tool with
no custom vocabulary and no filler cleanup.

## The gap

Server (`apps/server/src/dictation/`):

- [x] A `DictationService` with `transcribe(pcm: Int16 16 kHz mono) => text`,
      running the model in a child process so native crashes do not take the
      server down.
- [x] FIFO queue: requests run one at a time, none rejected as busy.
- [x] Model download on first use into `<T3 home>/models/dictation/`, SHA-256
      verified, with progress reported to the client; remove on request.
- [x] Model unload after 60 minutes idle; reload on the next request (cold
      load measured at ~6 s in the spike).
- [x] Filler cleanup pass (um, uh, er, ah, "you know", doubled words), on by
      default, toggle in settings.
- [x] Dictionary pass: `heard => wanted` lines, case-insensitive, whole-word,
      applied after filler cleanup.
- [x] The last transcription's raw and cleaned text kept in memory for the
      settings preview (not persisted).
- [x] HTTP route `POST /api/dictation/transcribe`: body is raw PCM, response is
      `{ text, raw }`; authenticated with the orchestration-operate scope; body
      capped at 5 minutes of audio (9.6 MB).
- [x] HTTP route `GET /api/dictation/status` returning model state
      (`missing | downloading { percent } | ready`) and the last raw/cleaned
      pair; `DELETE /api/dictation/model` to remove the model.
- [x] Hidden CLI subcommand `__dictation-worker` and a Vite entry so the worker
      exists inside the packed executable.
- `transcribe-cpp` listed as an external CLI runtime package and in the
  third-party license overrides if it lacks a LICENSE file.

Contracts (`packages/contracts/src/settings.ts`, fork fields only):

- [x] Server settings `dictation: { fillerCleanup: boolean (default true),
  dictionary: string (default "") }` with `Schema.optionalKey` in the patch.

Web (`apps/web/src/dictation/` plus one-line mounts):

- [x] Mic button beside the paperclip in the composer footer, on existing and
      new threads, keeping editor focus on click.
- [x] Keybinding `composer.dictate`, default `mod+shift+u`, `when:
  !terminalFocus`, listed in Keybindings settings and the command palette.
- [x] Recorder: `getUserMedia` mono, resampled to 16 kHz Int16 in the browser.
- [x] Recording pill replacing the button: level meter (a few bars from an
      `AnalyserNode`, about 15 updates/s, only while the mic is open) and an
      elapsed timer ticking once a second.
- [x] Auto-stop at 5:00 with the captured audio transcribed.
- [x] Escape while recording cancels and discards.
- [x] Transcribing state: indeterminate progress bar in the pill until the
      response lands; the composer stays editable.
- [x] Download state: when status is `missing`, the first click starts the
      download and the pill shows percent until `ready`, then records.
- [x] Text inserted at the cursor of the composer it started in. If the user
      navigated away, appended to that thread's draft in the draft store.
- [x] One recording at a time: starting another, or switching threads, stops the
      current one and transcribes it.
- [x] The shortcut dictates into whichever textarea, text input or
      contenteditable has focus when that is not the composer, inserting at
      its selection (native setter plus an `input` event so controlled fields
      see it), with the pill floating above the field's top-right corner,
      repositioned on scroll and resize only. A field gone by completion falls
      back to the composer, then the thread's draft. The quote-comment popover
      gets its own mic button (`DictationFieldButton`, one-line mount in
      `AssistantCitationCommentEditor.tsx`).
- [x] Failure: a `toastManager` error with the server's reason; audio discarded.
- [x] Settings: a "Voice" section on the General settings page (no Chat page exists in current upstream) with the filler
      toggle, the dictionary text area (one `heard => wanted` per line), model
      state with a Remove button, and the last transcription raw vs cleaned.

Docs:

- [x] `docs/user/` section: how to start, the shortcut, the dictionary format,
      where the model lives and how to remove it.

## Architecture

New, fork-owned:

```
apps/server/src/dictation/
  DictationService.ts     Effect service: queue, model lifecycle, cleanup
  worker.ts               child process: loads transcribe-cpp, transcribes
  http.ts                 layerDictationRoutes (raw HttpRouter routes)
  cleanup.ts              filler and dictionary passes (pure, tested)
  model.ts                download, verify, remove
apps/server/src/cli/dictationWorker.ts   hidden subcommand entry
apps/web/src/dictation/
  useDictation.ts         state machine: idle / downloading / recording /
                          transcribing; owns the single active recording
  recorder.ts             getUserMedia, resample, level meter source
  DictationButton.tsx     button and pill
  VoiceSettingsSection.tsx
packages/contracts/src/dictation.ts      status and response schemas
```

One-line mounts in upstream files:

- `apps/server/src/server.ts`: `layerDictationRoutes` added to the raw route
  `Layer.mergeAll` list beside `layerAttachmentUploadRoute`.
- `apps/server/src/binCli.ts` and `apps/server/vite.config.ts`: the worker
  subcommand and entry, as `__claude-history` is registered.
- `apps/server/package.json`: `transcribe-cpp`.
- `scripts/lib/cli-external-packages.ts`: the `transcribe-cpp` and
  `@transcribe-cpp/` prefixes; `third-party-licenses.config.json` override if
  needed.
- `packages/contracts/src/settings.ts`: the `dictation` field and patch.
- `packages/contracts/src/keybindings.ts` and
  `packages/shared/src/keybindings.ts`: the command and its default.
- `apps/web/src/components/chat/ChatComposer.tsx`: `<DictationButton />`
  after the paperclip block; `insertTextAtCursor` added to
  `ChatComposerHandle` beside `insertTextAtEnd`.
- `apps/web/src/components/ChatView.tsx`: the `composer.dictate` case beside
  `modelPicker.toggle`.
- `apps/web/src/components/CommandPalette.tsx`: one action item.
- `apps/web/src/components/settings/SettingsPanels.tsx`:
  `<VoiceSettingsSection />` on the Chat page.

Auth on the route follows the OTLP route's inline pattern in
`apps/server/src/http.ts` (`authenticateHttpRequest` plus a scope check). The
client sends the upload with the same credentials as other authenticated
environment HTTP calls (cookie on the primary origin, bearer or DPoP on a
remote connection); the phone PWA path is a verification item, not an
assumption.

Contracts change only by adding optional fields and new schemas; existing
settings files load unchanged.

## What stays intact

- Composer behaviour with the feature unused: typing, attachments, send,
  stash, drafts. Gate: existing `ChatComposer` and `composerDraftStore`
  tests pass unchanged.
- Settings files without a `dictation` key decode as before. Gate:
  `packages/contracts/src/settings.test.ts` and
  `apps/server/src/serverSettings.test.ts` pass unchanged.
- Server start time and idle memory when dictation is never used: the model
  is not loaded and the worker is not spawned. Gate: `DictationService` test
  asserts no spawn before the first request.
- No idle repaint: when not recording or transcribing, nothing in the pill
  animates. Gate: visual check in the dogfood pass.
- `/build` and the desktop artifact still produce a working executable with
  the native dependency staged. Gate: build log has no `invalid package
  notice` and `apps/web/dist/third-party-licenses.json` lists
  `transcribe-cpp`.

## Done when

1. In the `pnpm dev:desktop` instance, pressing `mod+shift+u`, saying a
   sentence, and pressing it again puts that sentence at the cursor within
   about 2 seconds of stopping. Proof: a short recording,
   `~/.t3/dev/dictation-desktop.mp4` (not committed).
2. The same works from the phone PWA over Tailscale against the dev server.
   Proof: a screenshot of the composer with dictated text,
   `~/.t3/dev/dictation-phone.png`.
3. A dictionary entry `tee three => T3` turns the spoken "tee three" into
   "T3" in the inserted text, and the Voice section shows raw "tee three"
   beside cleaned "T3". Proof: screenshot of that section.
4. With the model removed in settings, the next mic click downloads it with
   visible percent and then records. Proof: the dev server log shows one
   download and one load.
5. Three composers dictating back to back all receive their text; none shows
   an error. Proof: `DictationService.test.ts` queue test plus the dogfood
   pass.

## Phases

1. **Spike.** `transcribe-cpp` loads under portable Node 24 from a script and
   transcribes a WAV; the desktop artifact build stages it. Ends with a note
   in the run log naming the fallback if it fails (whisper.cpp subprocess).
   Gate: "What stays intact", build item.
2. **Server service and routes.** `DictationService`, worker, model
   download, routes, hidden subcommand. No cleanup yet. Proof: service tests
   (queue, idle unload, no-spawn-before-use) and a `curl` of a WAV's PCM to
   the route returning text.
3. **Composer button and shortcut.** Button, pill states, recorder,
   insertion at cursor and into a navigated-away draft, keybinding, palette
   item, toast on failure. Proof: Done 1.
4. **Cleanup and dictionary.** `cleanup.ts` with tests, settings fields,
   wired into the service. Proof: Done 3 minus the settings UI (dictionary
   set via a settings patch).
5. **Voice settings section.** Toggle, dictionary editor, model state and
   Remove, raw vs cleaned preview. Proof: Done 3 and Done 4.
6. **Phone pass and docs.** Verify over Tailscale, write the user doc
   section, update `FORK_ROADMAP.md` item 11. Proof: Done 2.

## Verification

Before each phase is called done, scoped to the files touched, with portable
Node on PATH (see `FORK_ORCHESTRATOR.md`):

```
vp lint apps/server/src/dictation apps/web/src/dictation packages/contracts/src/dictation.ts
vp run --filter @t3tools/server typecheck
vp run --filter @t3tools/web typecheck
vp run --filter @t3tools/contracts typecheck
vp test run apps/server/src/dictation apps/web/src/dictation packages/contracts/src/settings.test.ts apps/server/src/serverSettings.test.ts
git ls-files --eol -- <new files>      # must show i/lf w/lf
```

Dogfood in a worktree with `pnpm dev:desktop` (separate `~/.t3/dev`
database), never against the daily driver. Run the control first: confirm the
composer works with the feature untouched before testing dictation. Browsers
or computer use only with the owner's permission.
