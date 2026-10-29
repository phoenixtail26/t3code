// Per-device OS notification sound for upstream's ThreadNotificationCoordinator,
// which imports `playNotificationSound` from here instead of ../threadNotifications.
import { getClientSettings } from "../hooks/useSettings";
import { playNotificationSound as playSoundFile } from "../lib/notificationSound";
import {
  playNotificationSound as playBundledNotificationSound,
  unlockNotificationAudio,
} from "../threadNotifications";

/**
 * Drop-in for upstream's `playNotificationSound` that honours the fork's
 * per-device OS sound choice (`desktopNotificationSoundPath`). Empty means
 * upstream's bundled sounds.
 */
export async function playNotificationSound(
  kind: "completion" | "input",
  shouldPlay: () => boolean,
): Promise<void> {
  const soundPath = getClientSettings().desktopNotificationSoundPath;
  if (!soundPath) return playBundledNotificationSound(kind, shouldPlay);
  if (!shouldPlay()) return;
  await playSoundFile(soundPath);
}

/** Settings preview: the chosen OS sound, or upstream's completion sound. */
export async function previewNotificationSound(soundPath: string): Promise<boolean> {
  if (soundPath.length === 0) {
    unlockNotificationAudio();
    await playBundledNotificationSound("completion", () => true);
    return true;
  }
  return playSoundFile(soundPath);
}
