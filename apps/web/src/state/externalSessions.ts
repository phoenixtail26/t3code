import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { createEnvironmentExternalSessionsAtoms } from "@t3tools/client-runtime/state/external-sessions";
import type {
  EnvironmentId,
  ExternalSessionShell,
  ExternalSessionTranscript,
  ExternalSessionTranscriptError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * External Claude Code sessions ("the radar") — fork feature. Wires the
 * per-environment state factory from client-runtime to the web app's
 * connection runtime, mirroring `apps/web/src/state/shell.ts`.
 */
export const environmentExternalSessions =
  createEnvironmentExternalSessionsAtoms(connectionAtomRuntime);

const EMPTY_EXTERNAL_SESSION_ATOM = Atom.make<ExternalSessionShell | null>(null).pipe(
  Atom.withLabel("web-external-session:empty"),
);

/**
 * Look up a single external session shell by id within an environment. The
 * radar only watches the local filesystem, so this is scoped to the
 * environment that owns the transcript file — usually the primary
 * environment, but the read-only transcript route carries its own
 * `environmentId` param, so callers pass it explicitly rather than assuming
 * primary.
 */
export function useExternalSessionShell(
  environmentId: EnvironmentId | null,
  sessionId: string,
): ExternalSessionShell | null {
  return useAtomValue(
    environmentId === null
      ? EMPTY_EXTERNAL_SESSION_ATOM
      : environmentExternalSessions.sessionByIdAtom(environmentId, sessionId),
  );
}

export interface ExternalSessionTranscriptQueryView {
  readonly data: ExternalSessionTranscript | null;
  /** Structured failure reason when the server rejected the request with `ExternalSessionTranscriptError`; null for other failures (e.g. auth) or no failure. */
  readonly errorReason: ExternalSessionTranscriptError["reason"] | null;
  readonly errorMessage: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

function isExternalSessionTranscriptError(error: unknown): error is ExternalSessionTranscriptError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { _tag: unknown })._tag === "ExternalSessionTranscriptError"
  );
}

/**
 * Fetch the read-only transcript for one external session. A thin wrapper
 * around the client-runtime SWR query atom — `refresh()` is exposed so
 * `ExternalSessionView` can force a refetch when the session shell's
 * `lastActivityAt` changes, since the query key (environmentId + sessionId)
 * doesn't change on its own between polls.
 */
export function useExternalSessionTranscript(
  environmentId: EnvironmentId,
  sessionId: string,
): ExternalSessionTranscriptQueryView {
  const atom = environmentExternalSessions.transcript({
    environmentId,
    input: { sessionId },
  });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const cause = result._tag === "Failure" ? Cause.squash(result.cause) : null;
  const transcriptError = isExternalSessionTranscriptError(cause) ? cause : null;
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    errorReason: transcriptError?.reason ?? null,
    errorMessage:
      cause === null
        ? null
        : (transcriptError?.message ??
          (cause instanceof Error ? cause.message : "The transcript request failed.")),
    isPending: result.waiting,
    refresh,
  };
}
