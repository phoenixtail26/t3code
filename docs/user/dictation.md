# Dictation

Speak a prompt into the composer on desktop or in a browser, including a phone
browser. Speech is transcribed on the machine running T3 Code, offline, and the
text lands at the cursor for you to review. Nothing is sent until you send it.
Dictation is English only.

## Dictate a prompt

Start and stop recording with the microphone button beside the attachment
button, with `mod+shift+u`, or with **Dictate into composer** in the command
palette. Press `Escape` while recording to discard it. Recordings stop on their
own after 5 minutes and are transcribed.

If you switch threads or start dictating in another composer while recording,
the current recording stops and its text goes into the thread where you started
it.

A browser only allows the microphone over HTTPS or on `localhost`. To dictate
from a phone, open T3 Code over an HTTPS address, such as a Tailscale HTTPS
name. The native iPhone app has its own voice input; see
[Messages and context](./composer.md#voice-input-on-iphone).

## The speech model

The first dictation downloads an English speech model of about 700 MB, then
starts recording. It is stored in `models/dictation/` under your T3 home and
stays loaded for an hour after the last use; the first dictation after that
takes a few seconds longer.

Manage it in **Settings → General → Voice**: **Download** fetches it ahead of
time and **Remove** deletes it from disk, cancelling a download in progress.
The next dictation downloads it again.

## Transcribe through Hearsay

T3 Code has two ways to speak into the composer, and Hearsay serves only one
of them:

- **Voice input** is the microphone button whose tooltip reads **Start voice
  input**, and `mod+shift+d`. It is set up with **Transcribe with** on the
  **Voice** page. This is the one that can transcribe through Hearsay.
- **Dictation** is the microphone button whose tooltip reads **Dictate**,
  `mod+shift+u`, and **Dictate into composer** in the command palette. It is
  what the rest of this guide describes, it always uses its own bundled
  model, and Hearsay does not serve it.

Voice input can hand its recordings to a Hearsay speech service running on
the environment that transcribes for you, instead of the bundled engine. Its
settings are on the **Voice** page, **Settings → Voice**, which is a
different place from the **Voice** section of the General page that
Dictation uses.

In **Settings → Voice → Transcription**, directly under **Transcribe with**
once an environment is chosen there:

- **Hearsay URL** is where Hearsay listens, for example
  `http://127.0.0.1:47700`. Empty means the bundled engine, and nothing else
  changes. With a URL set, recordings go to Hearsay as 16 kHz mono PCM and
  the text Hearsay returns lands in the composer. The bundled engine is never
  started while the URL is set. A bundled model that was already loaded
  before you set the URL stays in memory until its **Unload model** time
  runs out; if that is **Never**, restart T3 Code to release it.
- **Hearsay token** is the token from Hearsay's config. It is needed
  whenever Hearsay's config sets a token, on loopback too; Hearsay must set
  one to listen on any address that is not loopback. Leave it empty when
  Hearsay's config has none. It is an ordinary setting: it is stored in the
  environment's `settings.json` and sent to every client of that
  environment.

With the URL set, the model card shows Hearsay's recogniser: **Download**
starts the download in Hearsay and the card shows its progress; recording
is offered once Hearsay reports the model ready. Cancelling stops a download
that is still running. The model cannot be removed from T3 Code, because
Hearsay's other clients use it too: remove it in Hearsay's settings window.
The bin on its card only answers that the environment rejected the request.

**Test model** on the card shows the text after Hearsay's own cleanup, not
the raw recognition, whatever the line under it says about cleanup being
skipped. Hearsay's own status shows the raw and the cleaned text side by
side.

Hearsay transcribes, so the **Transcription options** (silence filtering,
filler words and the dictionaries) are not used: the section says so and
disables its controls. Set the dictionary and filler words in Hearsay's
settings window. **Hardware** and **Unload model** under
**Advanced** are disabled too, since Hearsay runs the model. The **Cleanup**
section, which runs on the transcript afterwards, still applies.

There is no fallback to the bundled engine: when Hearsay fails, fix it or
clear the URL. What a failure looks like depends on when it happens:

- **Before you record**, when Hearsay cannot be reached or is not installed
  with its recogniser: the "Voice input is not available" notice and the
  Voice page show the reason, for example
  `Hearsay at http://127.0.0.1:47700 did not answer: connect ECONNREFUSED 127.0.0.1:47700`.
- **During a transcription**, when Hearsay answers with an error or does not
  answer in time: T3 Code shows its usual transcription failure, and the
  reason is in the server log, for example
  `Hearsay at http://127.0.0.1:47700 did not answer: engine failed to load`.
  Recording again retries. While Hearsay's recogniser stays broken, the
  model card on the Voice page reads "Hearsay's last attempt failed" with
  Hearsay's reason.

Each forwarded recording is logged as
`speech: forwarded to Hearsay at <url>, entry <id>`, where the id is the
entry in Hearsay's history.

Hearsay's own dictation hotkey app and Dictation (`mod+shift+u`) are
unaffected by these settings.

## Clean up the text

Also in **Settings → General → Voice**:

- **Filler cleanup** removes um, uh, er, ah, a set-off "you know", and doubled
  words. It is on by default.
- **Dictionary** corrects words the model gets wrong. Write one correction per
  line as `heard => wanted`, for example `cloud code => Claude Code`. Matching
  ignores case and only replaces whole words. Corrections run after filler
  cleanup, top to bottom.
- **Last transcription** shows what the model heard beside the text that was
  inserted, so you can check what the cleanup and dictionary changed. It is
  kept only until the server restarts.

These settings do not appear in settings search, and **Restore defaults** does
not reset them. Use the reset arrow on each row instead.

## Read aloud

With a Hearsay URL set (**Settings → Voice → Transcription**, see above),
T3 Code can read an assistant reply to you in Hearsay's voice. It speaks the reply's words and skips its code blocks in
silence: headings, lists and tables are read as plain sentences, and links
are read by their text.

Each finished reply has a **Read aloud** button beside its copy button.
`mod+alt+r` reads the last finished reply of the open thread. While a reply
is being read, the same key, `Escape`, or the button (now **Stop reading**)
stops it; so does starting voice input or dictation, and reading another
reply. Rebind the key under **Settings → Keybindings** as **Chat: Read
Aloud**.

The voice comes from the Hearsay service of the environment the thread runs
on, through the same T3 Code server that transcribes for you, so it works
on the desktop and in a phone browser alike. Which voice speaks is chosen in
Hearsay's settings window. The first reading after Hearsay starts, or after
its voice has been idle for an hour, waits for the voice to load before
anything is heard; the button says so meanwhile. Without a Hearsay URL
there is no button and the key does nothing.
