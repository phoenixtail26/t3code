import { useAtomValue } from "@effect/atom-react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ExternalSessionShell } from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { Atom } from "effect/reactivity";
import { environmentExternalSessions } from "../state/externalSessions";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentServerConfigsAtom } from "../state/server";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { resolveClaudeAgentAdoptModelSelection } from "../threadFork/adoptModelSelection";
import { useAdoptExternalSession } from "../threadFork/useAdoptExternalSession";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "./ui/sidebar";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";
import type { ThreadStatusPill } from "./Sidebar.logic";

/**
 * Read-only sidebar section listing external Claude Code CLI sessions matched
 * to the current project; data source in `apps/server/src/externalSessions/DESIGN.md`.
 */

// `ThreadStatusPill["label"]` is a closed union of in-app thread states with no
// literal for an idle foreign session, so the idle label is asserted through
// the field type; "Working" is reused verbatim.
const EXTERNAL_SESSION_WORKING_PILL: ThreadStatusPill = {
  label: "Working",
  colorClass: "text-sky-600 dark:text-sky-300/80",
  dotClass: "bg-sky-500 dark:bg-sky-300/80",
  pulse: true,
};

const EXTERNAL_SESSION_IDLE_PILL: ThreadStatusPill = {
  label: "Idle" as ThreadStatusPill["label"],
  colorClass: "text-muted-foreground/70",
  dotClass: "bg-muted-foreground/40",
  pulse: false,
};

// Best-effort "blocked on a permission prompt" (a long-running approved
// tool can look the same — see the contracts doc comment), hence the
// attention treatment without a stronger claim in the label.
const EXTERNAL_SESSION_WAITING_PILL: ThreadStatusPill = {
  label: "Waiting" as ThreadStatusPill["label"],
  colorClass: "text-amber-600 dark:text-amber-300/90",
  dotClass: "bg-amber-500 dark:bg-amber-300/90",
  pulse: true,
};

// Exported so `ExternalSessionView` (the read-only transcript route) can
// reuse the same state chrome in its header.
export const EXTERNAL_SESSION_STATE_PILLS: Record<ExternalSessionShell["state"], ThreadStatusPill> =
  {
    waiting: EXTERNAL_SESSION_WAITING_PILL,
    working: EXTERNAL_SESSION_WORKING_PILL,
    idle: EXTERNAL_SESSION_IDLE_PILL,
  };

/** Waiting sessions are the whole point of the radar — always on top. */
const EXTERNAL_SESSION_STATE_ORDER: Record<ExternalSessionShell["state"], number> = {
  waiting: 0,
  working: 1,
  idle: 2,
};

function sortExternalSessions(
  sessions: ReadonlyArray<ExternalSessionShell>,
): ReadonlyArray<ExternalSessionShell> {
  return [...sessions].sort((a, b) => {
    if (a.state !== b.state) {
      return EXTERNAL_SESSION_STATE_ORDER[a.state] - EXTERNAL_SESSION_STATE_ORDER[b.state];
    }
    return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
  });
}

function externalSessionTitle(session: ExternalSessionShell): string {
  return session.title ?? session.sessionId.slice(0, 8);
}

const EMPTY_EXTERNAL_SESSIONS_STATE_ATOM = Atom.make<ReadonlyMap<string, ExternalSessionShell>>(
  new Map(),
);

/**
 * Mount for the default (flat-list) sidebar: a single shelf at the tail of the
 * thread list, styled after the settled shelf (label, count while collapsed,
 * rule, chevron). Keeps Sidebar.tsx's fork footprint at an import + one
 * element.
 */
export function SidebarExternalSessions({
  projects,
  scopedProjectKeys,
}: {
  projects: ReadonlyArray<{ readonly id: string; readonly environmentId: EnvironmentId }>;
  /** `${environmentId}:${projectId}` keys of the active sidebar scope, null = all. */
  scopedProjectKeys: ReadonlySet<string> | null;
}) {
  const showExternalSessions = useClientSettings<boolean>(
    (settings) => settings.showExternalSessions,
  );
  // The radar only watches the local filesystem, so sessions are scoped to
  // the primary environment (same as useExternalSessionsForProject).
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const sessionsById = useAtomValue(
    primaryEnvironmentId === null
      ? EMPTY_EXTERNAL_SESSIONS_STATE_ATOM
      : environmentExternalSessions.stateValueAtom(primaryEnvironmentId),
  );
  const [expanded, setExpanded] = useState(false);
  const sessions = (() => {
    if (primaryEnvironmentId === null) return [];
    const visibleProjectIds = new Set(
      projects
        .filter(
          (project) =>
            project.environmentId === primaryEnvironmentId &&
            (scopedProjectKeys === null ||
              scopedProjectKeys.has(`${project.environmentId}:${project.id}`)),
        )
        .map((project) => project.id),
    );
    return sortExternalSessions(
      [...sessionsById.values()].filter((session) => visibleProjectIds.has(session.projectId)),
    );
  })();
  if (!showExternalSessions || primaryEnvironmentId === null || sessions.length === 0) {
    return null;
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
      >
        <span className="text-xs font-medium text-muted-foreground/50">
          {expanded ? "External" : `External (${sessions.length})`}
        </span>
        <span className="h-px flex-1 bg-sidebar-border/60" />
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 text-muted-foreground/50 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <ExternalSessionList sessions={sessions} environmentId={primaryEnvironmentId} />
      ) : null}
    </>
  );
}

/** Session rows plus the adopt context menu, mounted by SidebarExternalSessions. */
function ExternalSessionList({
  sessions,
  environmentId,
}: {
  sessions: ReadonlyArray<ExternalSessionShell>;
  environmentId: EnvironmentId;
}) {
  const sortedSessions = sortExternalSessions(sessions);
  const activeSessionId = useParams({
    strict: false,
    select: (params) => (params as { sessionId?: string }).sessionId ?? null,
  });

  // Adopting always continues on a claudeAgent instance (F6) — resolved
  // once per environment, same for every row, rather than per-session.
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const adoptModelSelection = resolveClaudeAgentAdoptModelSelection(
    serverConfigs.get(environmentId)?.providers ?? [],
  );
  const adoptSession = useAdoptExternalSession();
  const handleSessionContextMenu = (
    session: ExternalSessionShell,
    position: { x: number; y: number },
  ) => {
    if (!adoptModelSelection) return;
    void (async () => {
      const api = readLocalApi();
      if (!api) return;
      const clickedResult = await settlePromise(() =>
        api.contextMenu.show([{ id: "adopt", label: "Adopt as thread" }], position),
      );
      if (clickedResult._tag === "Failure" || clickedResult.value !== "adopt") return;
      void adoptSession({
        environmentId,
        sessionId: session.sessionId,
        modelSelection: adoptModelSelection,
      });
    })();
  };

  return (
    <div>
      {sortedSessions.map((session) => {
        const title = externalSessionTitle(session);
        const tooltip = session.cwd
          ? `${title}
${session.cwd}`
          : title;
        const isActive = activeSessionId === session.sessionId;
        return (
          <SidebarMenuSubItem key={session.sessionId} className="w-full">
            <SidebarMenuSubButton
              size="sm"
              isActive={isActive}
              title={tooltip}
              className="mx-0 flex h-6 w-full min-w-0 translate-x-0 items-center gap-1.5 rounded-none px-2 text-left sm:h-7"
              onContextMenu={(event: ReactMouseEvent<HTMLAnchorElement>) => {
                if (!adoptModelSelection) return;
                event.preventDefault();
                handleSessionContextMenu(session, { x: event.clientX, y: event.clientY });
              }}
              render={
                <Link
                  to="/$environmentId/external/$sessionId"
                  params={{ environmentId, sessionId: session.sessionId }}
                />
              }
            >
              <ThreadStatusLabel status={EXTERNAL_SESSION_STATE_PILLS[session.state]} compact />
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{title}</span>
              <span className="shrink-0 text-3xs tabular-nums text-muted-foreground/40">
                {formatRelativeTimeLabel(session.lastActivityAt)}
              </span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        );
      })}
    </div>
  );
}
