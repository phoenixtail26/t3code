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
