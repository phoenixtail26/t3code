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

T3 Code's own voice input (the microphone button and `mod+shift+d`, set up
under **Settings → Voice**) can hand its recordings to a Hearsay speech
service running on the environment that transcribes for you, instead of the
bundled engine.

In **Settings → Voice → Transcription**, with the transcribing environment
chosen under **Transcribe with**:

- **Hearsay URL** is where Hearsay listens, for example
  `http://127.0.0.1:47700`. Empty means the bundled engine, and nothing else
  changes. With a URL set, recordings go to Hearsay as 16 kHz mono PCM and
  the text Hearsay returns lands in the composer. The bundled engine is never
  started while the URL is set.
- **Hearsay token** is the token from Hearsay's config. Leave it empty unless
  Hearsay is bound to an address other than loopback, where it requires one.

With the URL set, the model card shows Hearsay's recogniser: **Download**
starts the download in Hearsay and the card shows its progress; recording
is offered once Hearsay reports the model ready. The **Transcription
options** section notes that the dictionary and cleanup are managed by
Hearsay and disables those controls: change them in Hearsay's settings
window. The **Cleanup** section, which runs on the transcript afterwards,
still applies.

If Hearsay cannot be reached, answers with an error, or does not answer in
time, the dictation fails with a message naming the URL and the reason, for
example
`Hearsay at http://127.0.0.1:47700 did not answer: engine failed to load`.
When Hearsay is down before you record, that message is what the "Voice
input is not available" notice and the Voice panel show. When a recording
fails part way, T3 Code shows its usual transcription failure and the
message is in the server log. There is no fallback to the bundled engine:
fix or clear the URL. A recording longer than five minutes is refused
without being sent. Each forwarded recording is logged as
`speech: forwarded to Hearsay at <url>, entry <id>`, where the id is the
entry in Hearsay's history.

Hearsay's dictation hotkey app and the composer dictation below
(`mod+shift+u`) are unaffected by these settings.

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
