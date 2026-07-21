/**
 * "New build available" detection for the built desktop app.
 *
 * The long-running server serves apps/web/dist straight from disk, and a
 * rebuild (e.g. another thread's /build) rewrites those files under the
 * already-loaded renderer. The running client keeps its old, in-memory bundle
 * whose lazy route chunks may no longer exist on disk — so a toast click that
 * navigates to a not-yet-visited route silently fails to load its chunk. We
 * surface a manual "reload" affordance rather than auto-reloading, so
 * in-progress work is never disturbed until the user chooses to reload.
 *
 * Detection: every build stamps a BUILD_ID into both the client bundle (via
 * `import.meta.env.BUILD_ID`, the "running" id) and a non-fingerprinted
 * `/version.json` (the "served" id, always fetched no-store from the current
 * on-disk build). When the served id differs from the running id, a newer
 * build is on disk.
 */

const VERSION_ENDPOINT = "/version.json";

/** The build id baked into the currently-running bundle at build time. */
export function runningBuildId(): string {
  return import.meta.env.BUILD_ID ?? "";
}

/** Extract a non-empty `buildId` string from a parsed `/version.json` payload. */
export function parseBuildId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { buildId } = payload as { readonly buildId?: unknown };
  return typeof buildId === "string" && buildId.length > 0 ? buildId : null;
}

/**
 * A newer build is available when the served id is known and differs from the
 * running id. An unknown running id (feature not built with a BUILD_ID) or an
 * unreadable served id is treated as "no new build" — never a false positive.
 */
export function isNewBuildAvailable(running: string, served: string | null): boolean {
  if (running.length === 0 || served === null) return false;
  return served !== running;
}

/**
 * Fetch the build id currently served from disk. Returns null on any failure,
 * including a build with no `version.json` (the server's SPA fallback returns
 * index.html, so `json()` throws and we report "unknown" rather than a
 * spurious new build).
 */
export async function fetchServedBuildId(): Promise<string | null> {
  try {
    const response = await fetch(VERSION_ENDPOINT, { cache: "no-store" });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    return parseBuildId(payload);
  } catch {
    return null;
  }
}
