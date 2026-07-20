import type { ClaudeUsageLimit, ClaudeUsageSeverity, ClaudeUsageSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { CalendarClockIcon, GaugeIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

// Upstream summary is cached server-side for 60s; polling faster only reheats
// the cache. Focus refresh covers the "came back after lunch" glance.
const POLL_INTERVAL_MS = 60_000;

const SEVERITY_RANK = { normal: 0, warning: 1, error: 2 } as const;

const SEVERITY_TEXT = {
  normal: "text-muted-foreground",
  warning: "text-warning",
  error: "text-destructive",
} as const;

const SEVERITY_BAR = {
  normal: "bg-primary/70",
  warning: "bg-warning",
  error: "bg-destructive",
} as const;

function limitKey(limit: ClaudeUsageLimit): string {
  return `${limit.kind}:${limit.label}`;
}

/** Worst limit by severity; active limits break ties, then utilization. */
export function pickHeadlineLimit(
  limits: ReadonlyArray<ClaudeUsageLimit>,
): ClaudeUsageLimit | null {
  let headline: ClaudeUsageLimit | null = null;
  for (const limit of limits) {
    if (
      headline === null ||
      SEVERITY_RANK[limit.severity] > SEVERITY_RANK[headline.severity] ||
      (SEVERITY_RANK[limit.severity] === SEVERITY_RANK[headline.severity] &&
        (Number(limit.isActive) > Number(headline.isActive) ||
          (limit.isActive === headline.isActive && limit.percent > headline.percent)))
    ) {
      headline = limit;
    }
  }
  return headline;
}

/** The session (5-hour) window — the number worth keeping always on screen. */
export function pickSessionLimit(limits: ReadonlyArray<ClaudeUsageLimit>): ClaudeUsageLimit | null {
  return limits.find((limit) => limit.kind === "session") ?? pickHeadlineLimit(limits);
}

/**
 * The model-scoped weekly window (e.g. "Week · Fable") — the budget that can
 * burn through in a single heavy day, so it stays on screen from 0% rather
 * than surfacing only once it has already crossed into warning. Highest
 * utilization wins when the account has several scoped windows.
 */
export function pickScopedWeeklyLimit(
  limits: ReadonlyArray<ClaudeUsageLimit>,
  sessionLimit: ClaudeUsageLimit | null,
): ClaudeUsageLimit | null {
  let scoped: ClaudeUsageLimit | null = null;
  for (const limit of limits) {
    if (limit.kind !== "weekly_scoped" || limit === sessionLimit) continue;
    if (scoped === null || limit.percent > scoped.percent) {
      scoped = limit;
    }
  }
  return scoped;
}

/** Worst limit not already pinned on screen that has crossed into warning/error. */
export function pickAlertLimit(
  limits: ReadonlyArray<ClaudeUsageLimit>,
  pinnedLimits: ReadonlyArray<ClaudeUsageLimit | null>,
): ClaudeUsageLimit | null {
  const alertCandidates = limits.filter(
    (limit) => !pinnedLimits.includes(limit) && limit.severity !== "normal",
  );
  return pickHeadlineLimit(alertCandidates);
}

export function formatResetLabel(resetsAt: string | null, nowMs: number): string | null {
  if (!resetsAt) return null;
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return null;
  const deltaMinutes = Math.round((resetMs - nowMs) / 60_000);
  if (deltaMinutes <= 0) return "resets soon";
  const days = Math.floor(deltaMinutes / 1440);
  const hours = Math.floor((deltaMinutes % 1440) / 60);
  const minutes = deltaMinutes % 60;
  const relative =
    days > 0
      ? `resets in ${days}d ${hours}h`
      : hours > 0
        ? `resets in ${hours}h ${minutes}m`
        : `resets in ${minutes}m`;

  const reset = new Date(resetMs);
  const now = new Date(nowMs);
  const sameLocalDay =
    reset.getFullYear() === now.getFullYear() &&
    reset.getMonth() === now.getMonth() &&
    reset.getDate() === now.getDate();
  const timeLabel = reset.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const when = sameLocalDay
    ? timeLabel
    : `${reset.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}, ${timeLabel}`;
  return `${relative} (${when})`;
}

/**
 * Toast when a limit escalates into warning/error while the app is open.
 * The first summary only seeds the baseline — an app opened while already
 * at 91% should show the alert row, not greet the user with a toast.
 */
function notifyEscalations(
  known: Map<string, ClaudeUsageSeverity> | null,
  limits: ReadonlyArray<ClaudeUsageLimit>,
): Map<string, ClaudeUsageSeverity> {
  if (known === null) {
    return new Map(limits.map((limit) => [limitKey(limit), limit.severity]));
  }
  for (const limit of limits) {
    const key = limitKey(limit);
    const previous = known.get(key) ?? "normal";
    if (limit.severity !== "normal" && SEVERITY_RANK[limit.severity] > SEVERITY_RANK[previous]) {
      const resetLabel = formatResetLabel(limit.resetsAt, Date.now());
      toastManager.add({
        type: limit.severity === "error" ? "error" : "warning",
        title: `Claude usage: ${limit.label} at ${Math.round(limit.percent)}%`,
        ...(resetLabel ? { description: resetLabel } : {}),
      });
    }
    known.set(key, limit.severity);
  }
  return known;
}

function UsageLimitRow({ limit }: { readonly limit: ClaudeUsageLimit }) {
  const resetLabel = formatResetLabel(limit.resetsAt, Date.now());
  const barWidth = `${Math.max(0, Math.min(100, limit.percent))}%`;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-xs text-popover-foreground/90">{limit.label}</span>
        <span className={`text-xs font-medium tabular-nums ${SEVERITY_TEXT[limit.severity]}`}>
          {Math.round(limit.percent)}%
        </span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${SEVERITY_BAR[limit.severity]}`}
          style={{ width: barWidth }}
        />
      </div>
      {resetLabel && (
        <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{resetLabel}</div>
      )}
    </div>
  );
}

/**
 * Plan-usage meter for the sidebar footer: the session (5-hour) window and
 * the model-scoped weekly window (e.g. Fable) are always on screen; when any
 * other limit crosses into warning or error an extra alert row appears under
 * them, and escalations observed at runtime raise a toast. Hover shows the
 * full per-window breakdown — the same data as the Claude Code `/usage`
 * screen. Hidden while usage is unavailable (no Claude credentials, offline,
 * or no limit data).
 */
export function SidebarClaudeUsagePill() {
  const [summary, setSummary] = useState<ClaudeUsageSummary | null>(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const knownSeveritiesRef = useRef<Map<string, ClaudeUsageSeverity> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) => client.orchestration.claudeUsage({ headers: {} })),
        ),
      );
      if (next.status === "ok") {
        knownSeveritiesRef.current = notifyEscalations(knownSeveritiesRef.current, next.limits);
      }
      // A transient "unavailable" must not blank an already-shown meter;
      // keep the last good summary until fresh data arrives.
      setSummary((previous) =>
        next.status === "ok" || previous === null || previous.status !== "ok" ? next : previous,
      );
    } catch {
      // Not yet authenticated or the environment is unreachable; keep the
      // last summary (or stay hidden) and let the next poll retry.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const handleFocus = () => void refresh();
    window.addEventListener("focus", handleFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
    };
  }, [refresh]);

  if (summary === null || summary.status !== "ok" || summary.limits.length === 0) {
    return null;
  }
  const sessionLimit = pickSessionLimit(summary.limits);
  if (sessionLimit === null) return null;
  const scopedWeeklyLimit = pickScopedWeeklyLimit(summary.limits, sessionLimit);
  const alertLimit = pickAlertLimit(summary.limits, [sessionLimit, scopedWeeklyLimit]);

  return (
    <Tooltip onOpenChange={setBreakdownOpen} open={breakdownOpen}>
      <TooltipTrigger
        render={
          <div
            className="flex w-full cursor-pointer flex-col rounded-lg transition-colors hover:bg-accent"
            aria-label="Claude plan usage"
            onClick={() => setBreakdownOpen((open) => !open)}
          >
            <div className="flex h-7 items-center gap-2 px-2 text-xs text-muted-foreground/70">
              <GaugeIcon className="size-3.5" />
              <span>Session</span>
              <span
                className={`ml-auto font-medium tabular-nums ${SEVERITY_TEXT[sessionLimit.severity]}`}
              >
                {Math.round(sessionLimit.percent)}%
              </span>
            </div>
            {scopedWeeklyLimit && (
              <div className="flex h-7 items-center gap-2 px-2 pt-0 text-xs text-muted-foreground/70">
                <CalendarClockIcon className="size-3.5" />
                <span className="truncate">{scopedWeeklyLimit.label}</span>
                <span
                  className={`ml-auto font-medium tabular-nums ${SEVERITY_TEXT[scopedWeeklyLimit.severity]}`}
                >
                  {Math.round(scopedWeeklyLimit.percent)}%
                </span>
              </div>
            )}
            {alertLimit && (
              <div
                className={`mx-1 mb-1 flex h-6 items-center gap-2 rounded-md px-1.5 text-xs ${
                  alertLimit.severity === "error"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-warning/10 text-warning"
                }`}
              >
                <TriangleAlertIcon className="size-3" />
                <span className="truncate">{alertLimit.label}</span>
                <span className="ml-auto font-medium tabular-nums">
                  {Math.round(alertLimit.percent)}%
                </span>
              </div>
            )}
          </div>
        }
      />
      <TooltipPopup align="start" side="top">
        <div className="w-56 text-left">
          <div className="px-1 text-sm leading-5 font-medium">Claude plan usage</div>
          <div className="mt-3 flex flex-col gap-3 px-1 pb-1">
            {summary.limits.map((limit) => (
              <UsageLimitRow key={limitKey(limit)} limit={limit} />
            ))}
          </div>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
