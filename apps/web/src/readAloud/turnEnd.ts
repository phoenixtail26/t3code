// Fork feature: read aloud. The turns this client sent are watched, through the thread's
// projection, for the run each one started to end; a completed run's reply is then summarised
// aloud when the setting asks for it. Only the client that sent the message holds a turn
// here, so the other window or the phone stays quiet.
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import type { AtomRegistry } from "effect/reactivity";

import { environmentThreadDetails } from "../state/threads";
import { startReadAloud } from "./player";
import { readReadAloudMode } from "./setting";
import { readReadAloudState } from "./store";

export interface SentTurn {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The user message this client sent. */
  readonly messageId: MessageId;
  readonly dictated: boolean;
}

interface PendingTurn extends SentTurn {
  settled: boolean;
  unsubscribe: () => void;
}

// A turn whose message never reaches its thread (a send that failed after the mark) would
// otherwise be watched for good; the oldest goes when this many wait.
const MAX_PENDING = 8;
const ENDED = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

let registry: AtomRegistry.AtomRegistry | null = null;
const pending = new Map<string, PendingTurn>();

function settle(key: string, turn: PendingTurn): void {
  turn.settled = true;
  turn.unsubscribe();
  if (pending.get(key) === turn) pending.delete(key);
}

function hasUserActivation(): boolean {
  const activation = (navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return activation === undefined || activation.hasBeenActive;
}

function observe(key: string, turn: PendingTurn, thread: EnvironmentThread | null): void {
  if (turn.settled || thread === null) return;
  const { messages, runs } = thread.projection;
  const sent = messages.find((message) => message.id === turn.messageId);
  if (sent === undefined || sent.runId === null) return;
  const run = runs.find((candidate) => candidate.id === sent.runId);
  if (run === undefined || !ENDED.has(run.status)) return;
  settle(key, turn);
  if (run.status !== "completed") return;
  const reply = messages.findLast(
    (message) =>
      message.runId === run.id &&
      message.role === "assistant" &&
      !message.streaming &&
      message.text.trim() !== "",
  );
  if (reply === undefined) return;
  const mode = readReadAloudMode();
  if (mode === "off" || (mode === "dictated" && !turn.dictated)) return;
  // A reply the person asked to hear is not cut off by a summary; and a page nobody has
  // touched since it loaded cannot play sound (a reload loses the mark anyway).
  if (readReadAloudState().state !== "idle" || !hasUserActivation()) return;
  startReadAloud({
    environmentId: turn.environmentId,
    threadId: turn.threadId,
    messageId: reply.id,
    mode: "summary",
  });
}

/** Watches the turn this client just sent until its run ends. */
export function trackSentTurn(turn: SentTurn): void {
  if (registry === null) return;
  const ref = { environmentId: turn.environmentId, threadId: turn.threadId };
  const key = scopedThreadKey(ref);
  const previous = pending.get(key);
  if (previous !== undefined) settle(key, previous);
  if (pending.size >= MAX_PENDING) {
    const [oldestKey, oldest] = pending.entries().next().value!;
    settle(oldestKey, oldest);
  }
  const entry: PendingTurn = { ...turn, settled: false, unsubscribe: () => {} };
  pending.set(key, entry);
  const unsubscribe = registry.subscribe(
    environmentThreadDetails.threadAtom(ref),
    (thread) => observe(key, entry, thread),
    { immediate: true },
  );
  // The immediate call may have settled the turn before the subscription could be kept.
  if (entry.settled) unsubscribe();
  else entry.unsubscribe = unsubscribe;
}

/** Installs the watcher for the life of the app root; the disposer forgets every turn. */
export function installReadAloudTurnEnd(atoms: AtomRegistry.AtomRegistry): () => void {
  registry = atoms;
  return () => {
    for (const [key, turn] of Array.from(pending)) settle(key, turn);
    registry = null;
  };
}

export function pendingTurnCount(): number {
  return pending.size;
}
