import { useThreadAttentionNotifications } from "../hooks/useThreadAttentionNotifications";

/**
 * Headless mount point for {@link useThreadAttentionNotifications}. Rendered
 * once at the app root so notifications fire regardless of which route the
 * user is on — including while they are away from the app entirely.
 */
export function ThreadAttentionNotifier(): null {
  useThreadAttentionNotifications();
  return null;
}
