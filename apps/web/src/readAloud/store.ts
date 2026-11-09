// Fork feature: read aloud. What is being read, for the button and the key. It changes
// only when the state does, so nothing repaints while audio loads or plays.
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

export interface ReadAloudTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  /** The reply's words (the default) or a few spoken sentences about it. */
  readonly mode?: "full" | "summary";
}

export type ReadAloudState =
  | { readonly state: "idle" }
  | { readonly state: "loading"; readonly target: ReadAloudTarget }
  | { readonly state: "playing"; readonly target: ReadAloudTarget };

const IDLE: ReadAloudState = { state: "idle" };
let current: ReadAloudState = IDLE;
const listeners = new Set<() => void>();

export function readReadAloudState(): ReadAloudState {
  return current;
}

export function setReadAloudState(next: ReadAloudState): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useReadAloudState(): ReadAloudState {
  return useSyncExternalStore(subscribe, readReadAloudState, () => IDLE);
}

/** Whether this message is the one loading or playing. */
export function isReadingMessage(state: ReadAloudState, messageId: MessageId): boolean {
  return state.state !== "idle" && state.target.messageId === messageId;
}
