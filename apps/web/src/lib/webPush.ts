import { isElectron } from "~/env";

/**
 * Browser-side Web Push plumbing (fork feature, roadmap #6): service worker
 * registration and PushManager subscription management. Server registration
 * of the resulting subscription lives in `~/hooks/useWebPush.ts`.
 *
 * Electron is deliberately unsupported — the desktop app already delivers
 * native notifications; Web Push targets the phone PWA and plain browsers.
 */

const SERVICE_WORKER_URL = "/sw.js";

export function isWebPushSupported(): boolean {
  return (
    !isElectron &&
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isWebPushSupported()) return null;
  try {
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  } catch (error) {
    console.warn("[WEB_PUSH] service worker registration failed", error);
    return null;
  }
}

export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  if (!isWebPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

/** `applicationServerKey` wants raw bytes; the server hands out base64url. */
function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const padded = base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

export async function subscribeToWebPush(vapidPublicKey: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }
  const registration = await registerPushServiceWorker();
  if (registration === null) {
    throw new Error("Service worker registration failed.");
  }
  await navigator.serviceWorker.ready;
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(vapidPublicKey) as BufferSource,
  });
}

/** Rough human label so the server-side subscription list stays legible. */
export function describeThisDevice(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const platform = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad/i.test(ua)
      ? "iOS"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Mac/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "Unknown";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  return `${browser} on ${platform}`;
}
