// Fork feature: read aloud. "This draft was dictated" is this client's memory alone: a draft
// key is marked when upstream's voice input writes its transcript, read when the draft is
// sent, and forgotten when the draft is emptied. A reload forgets it, and that turn ends
// in silence.
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import {
  composerTargetKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "~/composerDraftStore";

import { trackSentTurn } from "./turnEnd";

const marks = new Set<string>();
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
    for (const key of Array.from(marks)) {
      const draft = state.draftsByThreadKey[key];
      if (draft === undefined || draft.prompt.trim() === "") forget(key);
    }
  });
}

/** Upstream's voice input wrote a transcript into the draft under `ownerKey`. */
export function markDraftDictated(ownerKey: string): void {
  if (!ownerKey) return;
  marks.add(ownerKey);
  watchDrafts();
}

/** The draft under `target` is being sent as `messageId`; its turn is watched for its end. */
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
  });
}

export function clearDictatedMarks(): void {
  for (const key of Array.from(marks)) forget(key);
}
