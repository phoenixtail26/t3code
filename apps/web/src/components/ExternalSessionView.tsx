import { useAtomValue } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react";
import type { EnvironmentId, MessageId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import type { TurnDiffSummary } from "../types";
import { environmentServerConfigsAtom } from "../state/server";
import { useExternalSessionShell, useExternalSessionTranscript } from "../state/externalSessions";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { resolveClaudeAgentAdoptModelSelection } from "../threadFork/adoptModelSelection";
import { useAdoptExternalSession } from "../threadFork/useAdoptExternalSession";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { EXTERNAL_SESSION_STATE_PILLS } from "./ExternalSessionsSection";
import { mapExternalTranscriptEntriesToTimeline } from "./ExternalSessionView.logic";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";

/**
 * Read-only transcript view for an external Claude Code session ("the
 * radar" — see `packages/contracts/src/externalSessions.ts`). Renders the
 * session's mapped conversation using the same `MessagesTimeline` the live
 * chat route uses, wired with inert props: nothing here can mutate a
 * session, so every callback into the timeline is a no-op and every
 * live-thread map is empty.
 */

// A pending refetch is cancelled and rescheduled on every `lastActivityAt`
// change, so a burst of activity coalesces into one request ~1s after it
// quiets down instead of one request per tick.
const TRANSCRIPT_REFRESH_DEBOUNCE_MS = 1_000;

const EMPTY_TURN_DIFF_SUMMARY_MAP = new Map<MessageId, TurnDiffSummary>();
const EMPTY_REVERT_COUNT_MAP = new Map<MessageId, number>();

function noop(): void {}

function externalTranscriptTitle(title: string | null, sessionId: string): string {
  return title ?? sessionId.slice(0, 8);
}

export interface ExternalSessionViewProps {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
}

export function ExternalSessionView({ environmentId, sessionId }: ExternalSessionViewProps) {
  const shell = useExternalSessionShell(environmentId, sessionId);
  const { data, errorReason, errorMessage, isPending, refresh } = useExternalSessionTranscript(
    environmentId,
    sessionId,
  );
  const { resolvedTheme } = useTheme();
  const timestampFormat = useEnvironmentSettings(environmentId).timestampFormat;
  const listRef = useRef<LegendListRef | null>(null);

  // Adopting (F6) always continues on a claudeAgent instance — null hides
  // the button when the environment has none configured.
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const adoptModelSelection = useMemo(
    () => resolveClaudeAgentAdoptModelSelection(serverConfigs.get(environmentId)?.providers ?? []),
    [serverConfigs, environmentId],
  );
  const adoptSession = useAdoptExternalSession();

  // Refetch (debounced) whenever the subscribed session shell reports fresh
  // activity — the transcript query's own key (environmentId + sessionId)
  // never changes, so nothing else would trigger a refetch while the tab
  // stays open.
  const lastActivityAt = shell?.lastActivityAt ?? null;
  const previousLastActivityAtRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastActivityAt === null) {
      return;
    }
    if (previousLastActivityAtRef.current === null) {
      previousLastActivityAtRef.current = lastActivityAt;
      return;
    }
    if (previousLastActivityAtRef.current === lastActivityAt) {
      return;
    }
    previousLastActivityAtRef.current = lastActivityAt;
    const timeoutId = setTimeout(() => {
      refresh();
    }, TRANSCRIPT_REFRESH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timeoutId);
    };
  }, [lastActivityAt, refresh]);

  const timelineEntries = useMemo(
    () => (data === null ? [] : mapExternalTranscriptEntriesToTimeline(data.entries)),
    [data],
  );

  if (data === null) {
    if (errorReason === "not-found") {
      return (
        <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center text-sm text-muted-foreground">
          <p>This session is no longer available.</p>
          <p className="text-xs text-muted-foreground/70">
            External sessions age out once their transcript file is no longer recent.
          </p>
        </div>
      );
    }
    if (errorMessage !== null) {
      return (
        <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
          <p>Couldn't load this session's transcript.</p>
          <p className="text-xs text-muted-foreground/70">{errorMessage}</p>
          <button
            type="button"
            className="mt-1 rounded-md border border-border/60 px-2 py-1 text-xs text-foreground hover:bg-accent"
            onClick={() => refresh()}
          >
            Retry
          </button>
        </div>
      );
    }
    if (isPending) {
      return (
        <div className="flex h-full min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading transcript…
        </div>
      );
    }
    return null;
  }

  const title = externalTranscriptTitle(data.title, data.sessionId);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
        <ThreadStatusLabel status={EXTERNAL_SESSION_STATE_PILLS[data.state]} compact />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</span>
        <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] tracking-wide text-muted-foreground/70 uppercase">
          Read-only
        </span>
        {adoptModelSelection && (
          <button
            type="button"
            className="shrink-0 rounded-md border border-border/60 px-2 py-1 text-xs text-foreground hover:bg-accent"
            onClick={() =>
              void adoptSession({
                environmentId,
                sessionId: data.sessionId,
                modelSelection: adoptModelSelection,
              })
            }
          >
            Adopt as thread
          </button>
        )}
        {data.truncated && (
          <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-300/90">
            Truncated
          </span>
        )}
        {data.cwd !== null && (
          <span className="hidden shrink-0 truncate font-mono text-[10px] text-muted-foreground/60 sm:inline">
            {data.cwd}
          </span>
        )}
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
          {formatRelativeTimeLabel(data.lastActivityAt)}
        </span>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <MessagesTimeline
          isWorking={false}
          activeTurnStartedAt={null}
          liveFollowEnabled
          listRef={listRef}
          timelineEntries={timelineEntries}
          latestTurn={null}
          runningTurnId={null}
          turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFF_SUMMARY_MAP}
          routeThreadKey={`external:${sessionId}`}
          onOpenTurnDiff={noop}
          revertTurnCountByUserMessageId={EMPTY_REVERT_COUNT_MAP}
          onRevertUserMessage={noop}
          isRevertingCheckpoint={false}
          onImageExpand={noop}
          activeThreadEnvironmentId={environmentId}
          markdownCwd={data.cwd ?? undefined}
          resolvedTheme={resolvedTheme}
          timestampFormat={timestampFormat}
          workspaceRoot={data.cwd ?? undefined}
          anchorMessageId={null}
          onAnchorReady={noop}
          contentInsetEndAdjustment={0}
          onIsAtEndChange={noop}
          onManualNavigation={noop}
        />
      </div>
    </div>
  );
}

export default ExternalSessionView;
