// Fork feature: dictation. Shared by the main process and the preload, which
// must not import the main-process module.
export const DICTATION_GLOBAL_STOP_EVENT_CHANNEL = "desktop:dictation-global-stop";
export const SET_DICTATION_GLOBAL_STOP_CHANNEL = "desktop:set-dictation-global-stop";
