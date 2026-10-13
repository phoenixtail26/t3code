// Fork feature: dictation. Where the text goes when the composer that started
// the recording is no longer mounted: the end of that thread's stored draft.
import { type ComposerThreadTarget, useComposerDraftStore } from "../composerDraftStore";

export function appendDictationToDraft(target: ComposerThreadTarget, text: string): boolean {
  const store = useComposerDraftStore.getState();
  const existing = store.getComposerDraft(target)?.prompt ?? "";
  const joined =
    existing.length === 0 || /\s$/.test(existing) ? `${existing}${text}` : `${existing} ${text}`;
  store.setPrompt(target, joined);
  // `setPrompt` is a no-op for a target the store cannot resolve.
  return useComposerDraftStore.getState().getComposerDraft(target)?.prompt === joined;
}
