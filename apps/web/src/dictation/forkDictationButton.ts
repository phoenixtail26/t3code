// The composer shows one microphone, upstream's voice input (mod+shift+d), which the fork's
// HearsaySpeechService hands to Hearsay when a Hearsay URL is set. The fork's own dictation
// buttons (the local engine, never Hearsay) render nothing until phase 6 of the Hearsay plan
// removes them; mod+shift+u, the palette item and the recording pills still work.
export const SHOW_FORK_DICTATION_BUTTON = false;
