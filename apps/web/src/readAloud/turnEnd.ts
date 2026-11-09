// Fork feature: read aloud. The turns this client sent are watched for the run each one
// started to end; a completed run's reply is then summarised aloud when the setting asks for
// it. Only the client that sent the message holds a turn here, so the other window or the
// phone stays quiet.
import type { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { AtomRegistry } from "effect/reactivity";

import { environmentThreadDetails, environmentThreadShells } from "../state/threads";
import { startReadAloud } from "./player";
import { readReadAloudMode } from "./setting";
import { readReadAloudState } from "./store";

export interface SentTurn {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The user message this client sent. */
  readonly messageId: MessageId;
  readonly dictated: boolean;
  /** The draft's words as sent, for whoever needs to recognise them at send time. */
  readonly text: string;
  /** Called once the thread shows the message: the send was accepted. */
  readonly onAccepted?: () => void;
}

interface PendingTurn extends SentTurn {
  settled: boolean;
  accepted: boolean;
  /** The shell's latest run when the thread was first seen; undefined until then. */
  firstRunId: RunId | null | undefined;
  unsubscribeShell: () => void;
  unsubscribeDetail: (() => void) | null;
}

// A turn whose message never reaches its thread (a send rejected after the bind) would
// otherwise be watched for good; the oldest goes when this many wait.
const MAX_PENDING = 8;
const ENDED = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

let registry: AtomRegistry.AtomRegistry | null = null;
// Keyed by the sent message, so a follow-up on the same thread settles on its own run.
const pending = new Map<MessageId, PendingTurn>();

function settle(turn: PendingTurn): void {
  turn.settled = true;
  turn.unsubscribeShell();
  turn.unsubscribeDetail?.();
  if (pending.get(turn.messageId) === turn) pending.delete(turn.messageId);
}

function hasUserActivation(): boolean {
  const activation = (navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return activation === undefined || activation.hasBeenActive;
}

/** Whether the setting, as it stands, could ask for this turn's summary. */
function wanted(dictated: boolean): boolean {
  const mode = readReadAloudMode();
  return mode === "always" || (mode === "dictated" && dictated);
}

function observeDetail(turn: PendingTurn, thread: EnvironmentThread | null): void {
  if (turn.settled || thread === null) return;
  const { messages, runs } = thread.projection;
  const sent = messages.find((message) => message.id === turn.messageId);
  if (sent === undefined) return;
  if (!turn.accepted) {
    turn.accepted = true;
    turn.onAccepted?.();
  }
  if (sent.runId === null) return;
  const run = runs.find((candidate) => candidate.id === sent.runId);
  if (run === undefined || !ENDED.has(run.status)) return;
  settle(turn);
  if (run.status !== "completed") return;
  const reply = messages.findLast(
    (message) =>
      message.runId === run.id &&
      message.role === "assistant" &&
      !message.streaming &&
      message.text.trim() !== "",
  );
  if (reply === undefined || !wanted(turn.dictated)) return;
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

// The shell says when the thread exists and when its latest run ended; only then is the
// thread's detail read, to find which reply answered this message. Loading the detail any
// earlier would hit a 404 for a thread the send has not created yet, and the client would
// hold that thread as deleted (upstream's waitForShell rule).
function observeShell(turn: PendingTurn, shell: EnvironmentThreadShell | null): void {
  if (turn.settled || shell === null || turn.unsubscribeDetail !== null || registry === null)
    return;
  const run = shell.latestRun;
  if (turn.firstRunId === undefined) turn.firstRunId = run?.runId ?? null;
  if (run === null) return;
  // Runs on a thread go one at a time, so a newer run than the first one seen means the
  // earlier one, perhaps this turn's, has ended even though the shell no longer shows it.
  const laterRun = turn.firstRunId !== null && run.runId !== turn.firstRunId;
  if (!ENDED.has(run.status) && !laterRun) return;
  const unsubscribe = registry.subscribe(
    environmentThreadDetails.threadAtom({
      environmentId: turn.environmentId,
      threadId: turn.threadId,
    }),
    (thread) => observeDetail(turn, thread),
    { immediate: true },
  );
  // The immediate call may have settled the turn before the subscription could be kept.
  if (turn.settled) unsubscribe();
  else turn.unsubscribeDetail = unsubscribe;
}

/** Watches the turn this client just sent until its run ends. */
export function trackSentTurn(turn: SentTurn): void {
  // Nothing to say for this turn as the setting stands: no subscription either.
  if (registry === null || !wanted(turn.dictated)) return;
  const previous = pending.get(turn.messageId);
  if (previous !== undefined) settle(previous);
  if (pending.size >= MAX_PENDING) settle(pending.values().next().value!);
  const entry: PendingTurn = {
    ...turn,
    settled: false,
    accepted: false,
    firstRunId: undefined,
    unsubscribeShell: () => {},
    unsubscribeDetail: null,
  };
  pending.set(turn.messageId, entry);
  const unsubscribe = registry.subscribe(
    environmentThreadShells.quietThreadShellAtom({
      environmentId: turn.environmentId,
      threadId: turn.threadId,
    }),
    (shell) => observeShell(entry, shell),
    { immediate: true },
  );
  if (entry.settled) unsubscribe();
  else entry.unsubscribeShell = unsubscribe;
}

/** Installs the watcher for the life of the app root; the disposer forgets every turn. */
export function installReadAloudTurnEnd(atoms: AtomRegistry.AtomRegistry): () => void {
  registry = atoms;
  return () => {
    for (const turn of Array.from(pending.values())) settle(turn);
    registry = null;
  };
}

export function pendingTurnCount(): number {
  return pending.size;
}
