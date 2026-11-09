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
let unwatchDrafts: (() => void) | null = null;

function forget(key: string): void {
  marks.delete(key);
  if (marks.size === 0 && unwatchDrafts !== null) {
    unwatchDrafts();
    unwatchDrafts = null;
  }
}

// An emptied draft leaves the store, and a sent one is emptied by the send, so the mark lives
// exactly as long as the dictated words.
function watchDrafts(): void {
  if (unwatchDrafts !== null) return;
  unwatchDrafts = useComposerDraftStore.subscribe((state) => {
    for (const [key, target] of Array.from(marks)) {
      const draft = state.getComposerDraft(target);
      if (draft === null || draft.prompt.trim() === "") forget(key);
    }
  });
}

/** Upstream's voice input wrote a transcript into the draft under `target`. */
export function markDraftDictated(target: ComposerThreadTarget): void {
  const key = composerTargetKey(target);
  if (!key) return;
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
  trackSentTurn({
    environmentId,
    threadId,
    messageId,
    dictated: marks.has(composerTargetKey(target)),
    text: useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "",
  });
}

export function clearDictatedMarks(): void {
  for (const key of Array.from(marks.keys())) forget(key);
}
