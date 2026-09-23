import { useUserPresenceReporter } from "../hooks/useUserPresenceReporter";

/**
 * Headless mount for the presence heartbeat: tells the server this client is
 * in use so the phone push (apps/server/src/notifications) stays quiet while
 * the user is at this machine. Rendered once at the app root, independent of
 * the route, once the primary environment is authenticated.
 */
export function UserPresenceReporter(): null {
  useUserPresenceReporter();
  return null;
}
