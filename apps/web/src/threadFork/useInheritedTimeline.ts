import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId, ThreadInheritedTranscript } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { mapExternalTranscriptEntriesToTimeline } from "../components/ExternalSessionView.logic";
import type { TimelineEntry } from "../session-logic";
import { threadForkEnvironment } from "./state";

const EMPTY_TIMELINE: ReadonlyArray<TimelineEntry> = [];

const EMPTY_RESULT_ATOM = Atom.make(AsyncResult.initial<ThreadInheritedTranscript, never>()).pipe(
  Atom.withLabel("thread-fork:inherited-transcript:empty"),
);

/**
 * Inherited-history prelude for forked/adopted threads (FORK_PLAN_FORKING.md,
 * increment F8): the slice of the thread's Claude session transcript that
 * predates the thread's own first turn, mapped to the same `TimelineEntry`
 * shape ChatView's `deriveTimelineEntries` produces so it can be spread
 * ahead of the live timeline. Empty for ordinary threads — the server
 * answers those from the session binding alone (no filesystem work), so
 * calling this on every thread open is cheap.
 *
 * Ids are namespaced with `inherited:` — MessagesTimeline's row cache and
 * LegendList keys require ids unique across the merged array, and revert /
 * turn-diff affordances key off real MessageIds, so prefixed foreign rows
 * naturally render inert (same contract as ExternalSessionView).
 */
export function useInheritedTimeline(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<TimelineEntry> {
  const atom =
    environmentId !== null && threadId !== null
      ? threadForkEnvironment.inheritedTranscript({ environmentId, input: { threadId } })
      : EMPTY_RESULT_ATOM;
  const result = useAtomValue(atom);
  const data = Option.getOrNull(AsyncResult.value(result));

  return useMemo(() => {
    if (data === null || data.entries.length === 0) return EMPTY_TIMELINE;
    const prefixed = data.entries.map((entry) => ({
      ...entry,
      id: `inherited:${entry.id}`,
      turnId: entry.turnId === null ? null : `inherited:${entry.turnId}`,
    }));
    const timeline = mapExternalTranscriptEntriesToTimeline(prefixed);
    const last = timeline[timeline.length - 1];
    if (last === undefined) return EMPTY_TIMELINE;
    // Boundary marker between carried-in history and the thread's own turns.
    const boundary: TimelineEntry = {
      id: "inherited:boundary",
      kind: "work",
      createdAt: last.createdAt,
      entry: {
        id: "inherited:boundary",
        createdAt: last.createdAt,
        turnId: null,
        label: "Forked from here",
        tone: "thinking",
        detail:
          "The conversation above is carried-in context; checkpoints for it stay with the source.",
      },
    };
    return [...timeline, boundary];
  }, [data]);
}
