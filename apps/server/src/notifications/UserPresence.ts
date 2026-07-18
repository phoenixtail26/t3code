/**
 * Last time any connected client reported the user actually present at the
 * machine — window focused, or the OS reporting recent input while the app sits
 * in the background.
 *
 * Used to keep the phone quiet when the user is at their desk: they already got
 * a desktop notification, so a push to the pocket is pure duplication. Kept as
 * a module-level timestamp rather than a service because it is a single number
 * with no lifecycle, and the process boundary already scopes it correctly (a
 * restart forgets presence, which fails safe toward notifying).
 */

let lastPresentAtMs: number | null = null;

export function recordUserPresence(nowMs: number): void {
  lastPresentAtMs = nowMs;
}

export function readLastPresenceMs(): number | null {
  return lastPresentAtMs;
}

/** Test seam: forget any recorded presence. */
export function resetUserPresence(): void {
  lastPresentAtMs = null;
}

/**
 * True when a client reported presence within `windowSeconds`. A window of 0
 * disables suppression entirely, and a never-reported presence is always false
 * (browser-only clients that predate presence reporting must not silence the
 * phone).
 */
export function isUserPresent(input: {
  readonly nowMs: number;
  readonly windowSeconds: number;
  readonly lastPresentAtMs: number | null;
}): boolean {
  if (input.windowSeconds <= 0) return false;
  if (input.lastPresentAtMs === null) return false;
  return input.nowMs - input.lastPresentAtMs <= input.windowSeconds * 1000;
}
