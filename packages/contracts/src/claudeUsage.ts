import * as Schema from "effect/Schema";

/**
 * Claude plan-usage summary served by `GET /api/claude/usage`.
 *
 * The environment server proxies Anthropic's OAuth usage endpoint (the same
 * data the Claude Code `/usage` screen shows) using the Claude CLI's stored
 * credentials, and maps it to this stable shape so clients never depend on
 * the upstream wire format. When credentials are missing or the upstream
 * request fails, the summary degrades to `status: "unavailable"` instead of
 * an HTTP error so pollers can render a quiet empty state.
 */

export const ClaudeUsageSeverity = Schema.Literals(["normal", "warning", "error"]);
export type ClaudeUsageSeverity = typeof ClaudeUsageSeverity.Type;

export const ClaudeUsageLimit = Schema.Struct({
  /** Upstream limit kind, e.g. "session", "weekly_all", "weekly_scoped". */
  kind: Schema.String,
  /** Display label resolved server-side, e.g. "Week · Fable". */
  label: Schema.String,
  /** Utilization percent, 0-100 (may exceed 100 when over limit). */
  percent: Schema.Number,
  severity: ClaudeUsageSeverity,
  /** ISO timestamp when this window resets. */
  resetsAt: Schema.NullOr(Schema.String),
  /** Upstream marks the limit currently governing the account. */
  isActive: Schema.Boolean,
});
export type ClaudeUsageLimit = typeof ClaudeUsageLimit.Type;

export const ClaudeUsageUnavailableReason = Schema.Literals([
  "no-credentials",
  "request-failed",
  "unauthorized",
]);
export type ClaudeUsageUnavailableReason = typeof ClaudeUsageUnavailableReason.Type;

export const ClaudeUsageSummary = Schema.Struct({
  status: Schema.Literals(["ok", "unavailable"]),
  /** ISO timestamp when the summary was fetched (cache-aware). */
  checkedAt: Schema.String,
  limits: Schema.Array(ClaudeUsageLimit),
  unavailableReason: Schema.optional(ClaudeUsageUnavailableReason),
});
export type ClaudeUsageSummary = typeof ClaudeUsageSummary.Type;
