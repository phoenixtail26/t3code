import type { EnvironmentId, ExternalSessionShell } from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "./ui/sidebar";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";
import type { ThreadStatusPill } from "./Sidebar.logic";

/**
 * Read-only sidebar section listing external Claude Code CLI sessions ("the
 * radar") matched to the current project. Collapsed and quiet by default —
 * see `packages/contracts/src/externalSessions.ts` and
 * `apps/server/src/externalSessions/DESIGN.md` for the source of this data.
 */

// Hand-built pills — `ThreadStatusPill["label"]` is a closed union tied to
// in-app thread states, so there's no literal for a foreign/idle session.
// "Working" is reused verbatim (it is a member of the union and matches the
// intended color/pulse treatment); the idle label is asserted through the
// same field type since no existing literal fits.
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

export function externalSessionTitle(session: ExternalSessionShell): string {
  return session.title ?? session.sessionId.slice(0, 8);
}

export function ExternalSessionsSection({
  sessions,
  environmentId,
}: {
  sessions: ReadonlyArray<ExternalSessionShell>;
  /** Environment the sessions were matched against — carried into the read-only transcript route link. */
  environmentId: EnvironmentId;
}) {
  const [expanded, setExpanded] = useState(false);
  const sortedSessions = useMemo(() => sortExternalSessions(sessions), [sessions]);
  const activeSessionId = useParams({
    strict: false,
    select: (params) => (params as { sessionId?: string }).sessionId ?? null,
  });

  if (sessions.length === 0) {
    return null;
  }

  return (
    <div className="w-full">
      <button
        type="button"
        className="flex h-6 w-full items-center gap-1.5 px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80 sm:h-7"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150",
            expanded ? "rotate-90" : "",
          )}
        />
        <span className="flex-1 truncate">External</span>
        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground/60">
          {sessions.length}
        </span>
      </button>
      {expanded && (
        <div>
          {sortedSessions.map((session) => {
            const title = externalSessionTitle(session);
            const tooltip = session.cwd ? `${title}\n${session.cwd}` : title;
            const isActive = activeSessionId === session.sessionId;
            return (
              <SidebarMenuSubItem key={session.sessionId} className="w-full px-0">
                <SidebarMenuSubButton
                  size="sm"
                  isActive={isActive}
                  title={tooltip}
                  className="mx-0 flex h-6 w-full min-w-0 translate-x-0 items-center gap-1.5 rounded-none px-2 text-left sm:h-7"
                  render={
                    <Link
                      to="/$environmentId/external/$sessionId"
                      params={{ environmentId, sessionId: session.sessionId }}
                    />
                  }
                >
                  <ThreadStatusLabel status={EXTERNAL_SESSION_STATE_PILLS[session.state]} compact />
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {title}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/40">
                    {formatRelativeTimeLabel(session.lastActivityAt)}
                  </span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            );
          })}
        </div>
      )}
    </div>
  );
}
