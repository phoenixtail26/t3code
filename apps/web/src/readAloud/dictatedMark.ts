// Fork feature: read aloud. "This draft was dictated" is this client's memory alone: a draft
// is marked when upstream's voice input writes its transcript, read when the draft is sent,
// and forgotten when the draft is emptied. A reload forgets it, and that turn ends in silence.
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import {
  composerTargetKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "~/composerDraftStore";

import { trackSentTurn } from "./turnEnd";

// The store files a draft under its own resolution of the target (a thread's draft may sit
// under a draft id), so the target is kept and the lookup goes through the store.
const marks = new Map<string, ComposerThreadTarget>();
// A send empties the draft, and a send that then fails puts the same words back; the words
// of an emptied dictated draft are kept so the restored draft is dictated still.
const ghosts = new Map<string, { readonly target: ComposerThreadTarget; readonly text: string }>();
let unwatchDrafts: (() => void) | null = null;

function stopWatching(): void {
  if (marks.size === 0 && ghosts.size === 0 && unwatchDrafts !== null) {
    unwatchDrafts();
    unwatchDrafts = null;
  }
}

function watchDrafts(): void {
  if (unwatchDrafts !== null) return;
  unwatchDrafts = useComposerDraftStore.subscribe((state) => {
    for (const [key, target] of Array.from(marks)) {
      const draft = state.getComposerDraft(target);
      if (draft === null || draft.prompt.trim() === "") marks.delete(key);
    }
    for (const [key, ghost] of Array.from(ghosts)) {
      const draft = state.getComposerDraft(ghost.target);
      if (draft === null || draft.prompt.trim() === "") continue;
      ghosts.delete(key);
      if (draft.prompt === ghost.text) marks.set(key, ghost.target);
    }
    stopWatching();
  });
}

/** Upstream's voice input wrote a transcript into the draft under `target`. */
export function markDraftDictated(target: ComposerThreadTarget): void {
  const key = composerTargetKey(target);
  if (!key) return;
  ghosts.delete(key);
  marks.set(key, target);
  watchDrafts();
}

/**
 * The draft under `target` is being sent as `messageId`; its turn is watched for its end.
 * The draft's words go along for whoever needs them at send time.
 */
export function bindDictatedMark(
  target: ComposerThreadTarget,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
): void {
  const key = composerTargetKey(target);
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  // A send empties the draft; a failed one restores these same words, dictated still.
  if (marks.has(key) && draft !== null) ghosts.set(key, { target, text: draft.prompt });
  trackSentTurn({
    environmentId,
    threadId,
    messageId,
    dictated: marks.has(key),
    text: draft?.prompt ?? "",
    onAccepted: () => {
      ghosts.delete(key);
      stopWatching();
    },
  });
}

export function clearDictatedMarks(): void {
  marks.clear();
  ghosts.clear();
  stopWatching();
}
