import * as Effect from "effect/Effect";
import { useEffect } from "react";

import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";

/**
 * Tells the server the user is actually at this machine, so it can keep the
 * phone quiet while they are at their desk (they get a desktop notification
 * instead). See `apps/server/src/notifications/UserPresence.ts`.
 *
 * "Present" is deliberately broader than "focused": someone working in another
 * app on the same machine is still present, and pushing to their pocket then is
 * duplication. In Electron that comes from the OS idle timer; in a plain
 * browser, where no such signal exists, only focus counts — which fails safe
 * toward notifying.
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
  useEffect(() => {
    let cancelled = false;

    const report = async () => {
      if (cancelled || !(await isUserPresent())) return;
      try {
        await runPrimaryHttp(
          PrimaryEnvironmentHttpClient.pipe(
            Effect.flatMap((client) => client.orchestration.reportPresence({ headers: {} })),
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
