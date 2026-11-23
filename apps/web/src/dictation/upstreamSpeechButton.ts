// The composer shows one microphone: upstream's voice input (mod+shift+d), which the
// fork's HearsaySpeechService hands to Hearsay when a Hearsay URL is set. The fork's own
// DictationButton (mod+shift+u, the local engine, never Hearsay) stays hidden until
// phase 6 of the Hearsay plan removes it; its shortcut and palette item still work.
export const SHOW_UPSTREAM_SPEECH_BUTTON = true;
export const SHOW_FORK_DICTATION_BUTTON = false;
