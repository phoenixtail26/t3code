// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type ClaudeUsageLimit,
  type ClaudeUsageSeverity,
  type ClaudeUsageSummary,
  type ClaudeUsageUnavailableReason,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

/**
 * Proxy for Anthropic's OAuth usage endpoint — the data behind the Claude
 * Code `/usage` screen (per-window utilization percent, severity, reset
 * times). Authenticates with the Claude CLI's stored OAuth token, so the
 * numbers are the official plan-limit percentages, covering all Claude Code
 * usage on the account, not just sessions started from T3 Code.
 *
 * Credential notes: the CLI persists the token at
 * `<claude-config-dir>/.credentials.json` on Windows and Linux; on macOS it
 * lives in the login keychain instead, so this proxy degrades to
 * `unavailable (no-credentials)` there until a keychain reader is added.
 * Only the default config dir (`~/.claude`) is consulted — a custom
 * `CLAUDE_CONFIG_DIR`/homePath instance would need the instance settings
 * plumbed through here.
 */

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const REQUEST_TIMEOUT_MS = 10_000;
// Upstream usage counters move slowly; one refresh a minute keeps the meter
// current without hammering the endpoint from every connected client.
// Filled by fetches, invalidated by TTL expiry, cleared on server restart.
const CACHE_TTL_MS = 60_000;
// The endpoint rate-limits per account, and this server is not the only
// consumer (every Claude Code session polls it, plus any second T3 instance).
// Once a 429 arrives, retrying on the normal cadence just prolongs the
// blackout for every consumer — back off much further.
const RATE_LIMITED_TTL_MS = 5 * 60_000;

interface CacheEntry {
  readonly fetchedAtMs: number;
  readonly ttlMs: number;
  readonly summary: ClaudeUsageSummary;
}

const cacheByCredentialsPath = new Map<string, CacheEntry>();

function expandHomePath(value: string): string {
  if (value === "~") return NodeOS.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(NodeOS.homedir(), value.slice(2));
  }
  return value;
}

/** Mirrors the CLI's config-dir resolution used by `makeClaudeEnvironment`. */
export function resolveClaudeCredentialsPath(homePath: string): string {
  const trimmed = homePath.trim();
  const configDir =
    trimmed.length > 0
      ? NodePath.resolve(expandHomePath(trimmed))
      : NodePath.join(NodeOS.homedir(), ".claude");
  return NodePath.join(configDir, ".credentials.json");
}

function readAccessToken(credentialsPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(credentialsPath, "utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
    if (oauth === null || typeof oauth !== "object") return undefined;
    const token = (oauth as Record<string, unknown>).accessToken;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

interface UpstreamLimit {
  readonly kind?: unknown;
  readonly percent?: unknown;
  readonly severity?: unknown;
  readonly resets_at?: unknown;
  readonly is_active?: unknown;
  readonly scope?: { readonly model?: { readonly display_name?: unknown } | null } | null;
}

function normalizeSeverity(severity: unknown, percent: number): ClaudeUsageSeverity {
  if (severity === "normal" || severity === "warning" || severity === "error") {
    return severity;
  }
  return percent >= 100 ? "error" : percent >= 75 ? "warning" : "normal";
}

function limitLabel(kind: string, scopedModelName: string | undefined): string {
  if (kind === "session") return "Session";
  if (kind === "weekly_all") return "Week · all models";
  if (kind === "weekly_scoped") {
    return scopedModelName ? `Week · ${scopedModelName}` : "Week · scoped";
  }
  return kind.replace(/_/g, " ");
}

export function mapUpstreamLimits(payload: unknown): ReadonlyArray<ClaudeUsageLimit> {
  if (payload === null || typeof payload !== "object") return [];
  const rawLimits = (payload as Record<string, unknown>).limits;
  if (!Array.isArray(rawLimits)) return [];

  const limits: ClaudeUsageLimit[] = [];
  for (const raw of rawLimits as ReadonlyArray<UpstreamLimit>) {
    if (raw === null || typeof raw !== "object") continue;
    const kind = typeof raw.kind === "string" ? raw.kind : "unknown";
    const percent =
      typeof raw.percent === "number" && Number.isFinite(raw.percent) ? raw.percent : 0;
    const scopedModelName =
      typeof raw.scope?.model?.display_name === "string" ? raw.scope.model.display_name : undefined;
    limits.push({
      kind,
      label: limitLabel(kind, scopedModelName),
      percent,
      severity: normalizeSeverity(raw.severity, percent),
      resetsAt: typeof raw.resets_at === "string" ? raw.resets_at : null,
      isActive: raw.is_active === true,
    });
  }
  return limits;
}

function unavailableSummary(
  reason: ClaudeUsageUnavailableReason,
  checkedAt: string,
): ClaudeUsageSummary {
  return { status: "unavailable", checkedAt, limits: [], unavailableReason: reason };
}

/**
 * Fetch (or serve from the 60s cache) the usage summary for the Claude
 * config dir selected by `homePath` ("" = default `~/.claude`). Never
 * fails — upstream or credential problems yield `status: "unavailable"`.
 */
export const getClaudeUsageSummary = Effect.fn("getClaudeUsageSummary")(function* (
  homePath: string,
): Effect.fn.Return<ClaudeUsageSummary> {
  const credentialsPath = resolveClaudeCredentialsPath(homePath);
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const cached = cacheByCredentialsPath.get(credentialsPath);
  if (cached && nowMs - cached.fetchedAtMs < cached.ttlMs) {
    return cached.summary;
  }

  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const token = readAccessToken(credentialsPath);
  if (token === undefined) {
    // Not cached: a login can appear at any moment and should be picked up
    // by the next poll rather than after a TTL.
    return unavailableSummary("no-credentials", checkedAt);
  }

  const fetched = yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(USAGE_ENDPOINT).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
      HttpClientRequest.setHeader("anthropic-beta", "oauth-2025-04-20"),
    );
    const response = yield* client.execute(request).pipe(Effect.timeoutOption(REQUEST_TIMEOUT_MS));
    if (Option.isNone(response)) {
      return { summary: unavailableSummary("request-failed", checkedAt), rateLimited: false };
    }
    const httpResponse = response.value;
    if (httpResponse.status === 429) {
      return { summary: unavailableSummary("rate-limited", checkedAt), rateLimited: true };
    }
    if (httpResponse.status === 401 || httpResponse.status === 403) {
      return { summary: unavailableSummary("unauthorized", checkedAt), rateLimited: false };
    }
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      return { summary: unavailableSummary("request-failed", checkedAt), rateLimited: false };
    }
    const payload = yield* httpResponse.json;
    const summary: ClaudeUsageSummary = {
      status: "ok",
      checkedAt,
      limits: mapUpstreamLimits(payload),
    };
    return { summary, rateLimited: false };
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.orElseSucceed(() => ({
      summary: unavailableSummary("request-failed", checkedAt),
      rateLimited: false,
    })),
  );

  const { summary, rateLimited } = fetched;
  const ttlMs = rateLimited ? RATE_LIMITED_TTL_MS : CACHE_TTL_MS;
  if (summary.status === "unavailable" && cached?.summary.status === "ok") {
    // Stale-while-error: a transient upstream failure keeps serving the last
    // good numbers (and re-arms the TTL so the retry is paced) instead of
    // blanking every client's meter for a cycle.
    cacheByCredentialsPath.set(credentialsPath, {
      fetchedAtMs: nowMs,
      ttlMs,
      summary: cached.summary,
    });
    return cached.summary;
  }

  cacheByCredentialsPath.set(credentialsPath, { fetchedAtMs: nowMs, ttlMs, summary });
  return summary;
});
