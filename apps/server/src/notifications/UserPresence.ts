/**
 * Last time any connected client reported the user present (window focused, or
 * recent OS input while backgrounded). Keeps the phone quiet at the desk. A
 * module-level timestamp: a restart forgets presence, which fails safe toward notifying.
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
