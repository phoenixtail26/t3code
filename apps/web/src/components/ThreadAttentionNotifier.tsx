import { useThreadAttentionNotifications } from "../hooks/useThreadAttentionNotifications";
import { useUserPresenceReporter } from "../hooks/useUserPresenceReporter";

/**
 * Headless mount point for the two halves of "tell me once, on the right
 * screen": desktop notifications for this machine, and a presence heartbeat so
 * the server can skip the phone push while the user is at that machine.
 * Rendered once at the app root so both run regardless of the current route.
 */
export function ThreadAttentionNotifier(): null {
  useThreadAttentionNotifications();
  useUserPresenceReporter();
  return null;
}
