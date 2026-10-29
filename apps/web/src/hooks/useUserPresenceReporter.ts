import * as Effect from "effect/Effect";
import { useEffect } from "react";

import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";

/**
 * Tells the server the user is at this machine so it can keep the phone quiet
 * (see `apps/server/src/notifications/UserPresence.ts`). "Present" is broader
 * than focused: Electron uses the OS idle timer; a browser has only focus,
 * which fails safe toward notifying.
 */

const HEARTBEAT_INTERVAL_MS = 60_000;
// Comfortably under the server's default suppression window so an active user
// never lapses between beats.
const IDLE_PRESENT_THRESHOLD_SECONDS = 120;

async function isUserPresent(): Promise<boolean> {
  if (document.hasFocus()) return true;
  const getIdleSeconds = window.desktopBridge?.getSystemIdleSeconds;
  if (!getIdleSeconds) return false;
  try {
    return (await getIdleSeconds()) < IDLE_PRESENT_THRESHOLD_SECONDS;
  } catch {
    return false;
  }
}

export function useUserPresenceReporter(): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- heartbeat interval and window focus listener report presence to the server; neither is expressible in render
  useEffect(() => {
    let cancelled = false;

    const report = async () => {
      if (cancelled || !(await isUserPresent())) return;
      try {
        await runPrimaryHttp(
          PrimaryEnvironmentHttpClient.pipe(
            Effect.flatMap((client) => client.fork.reportPresence({ headers: {} })),
          ),
        );
      } catch {
        // Presence is advisory; a failed beat just means the phone may buzz.
      }
    };

    void report();
    const interval = setInterval(() => void report(), HEARTBEAT_INTERVAL_MS);
    // Returning to the app should register immediately rather than waiting for
    // the next beat, so an approval landing right then does not reach the phone.
    const handleFocus = () => void report();
    window.addEventListener("focus", handleFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);
}
