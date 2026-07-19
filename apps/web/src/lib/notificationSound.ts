/**
 * Notification sound playback.
 *
 * A chosen OS sound (Windows ships short WAVs in %SystemRoot%\Media) is read
 * through the desktop bridge and played from a blob URL — reading the bytes
 * rather than pointing an <audio> at a `file://` path keeps this working under
 * the renderer's content-security policy. With nothing chosen, or in a browser
 * where no bridge exists, a short two-note chime is synthesized instead, so the
 * feature never depends on shipping an audio asset.
 */

const objectUrlByPath = new Map<string, string>();

function playSynthesizedChime(): void {
  try {
    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    const context = new AudioContextCtor();
    const gain = context.createGain();
    gain.gain.value = 0.05;
    gain.connect(context.destination);
    const start = context.currentTime;
    for (const [index, frequency] of [660, 880].entries()) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(start + index * 0.12);
      oscillator.stop(start + index * 0.12 + 0.1);
    }
    window.setTimeout(() => void context.close(), 800);
  } catch {
    // Audio is a nicety; never let it break notification delivery.
  }
}

async function resolveObjectUrl(soundPath: string): Promise<string | null> {
  const cached = objectUrlByPath.get(soundPath);
  if (cached !== undefined) return cached;

  const read = window.desktopBridge?.readNotificationSound;
  if (!read) return null;
  const base64 = await read(soundPath);
  if (base64 === null) return null;

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  objectUrlByPath.set(soundPath, objectUrl);
  return objectUrl;
}

/**
 * Play the configured sound, falling back to the built-in chime.
 *
 * Returns whether the chosen sound actually played, so callers that can show
 * feedback (the settings preview) can say the choice did not work rather than
 * leaving the user to wonder why every option sounds identical — the failure
 * mode when `media-src` blocks blob URLs.
 */
export async function playNotificationSound(soundPath: string): Promise<boolean> {
  if (soundPath.length === 0) {
    playSynthesizedChime();
    return true;
  }
  try {
    const objectUrl = await resolveObjectUrl(soundPath);
    if (objectUrl === null) {
      playSynthesizedChime();
      return false;
    }
    await new Audio(objectUrl).play();
    return true;
  } catch (error) {
    // A missing, unreadable, or policy-blocked sound should still make *some*
    // noise, but the reason belongs in the console rather than nowhere.
    console.warn("Notification sound failed to play; using the built-in chime.", error);
    playSynthesizedChime();
    return false;
  }
}
