/**
 * T3 Code push service worker (fork feature, roadmap #6).
 *
 * Renders Web Push messages sent by the server's PushNotifierService and
 * deep-links back into the app on tap. The payload shape is
 * `WebPushMessagePayload` in `packages/contracts/src/webPush.ts` — this file
 * is served verbatim from `public/` and cannot import from the workspace, so
 * keep the two in sync by hand.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  const title = (payload && payload.title) || "T3 Code";
  const options = {
    body: (payload && payload.body) || "",
    icon: "/icon-512.png",
    badge: "/favicon-32x32.png",
    data: { url: (payload && payload.url) || "" },
  };
  // Coalesce repeated pushes for one thread into a single notification.
  if (payload && payload.tag) {
    options.tag = payload.tag;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = windows.find((client) => "focus" in client);
      if (existing) {
        await existing.focus();
        if (url) {
          // Cross-origin navigation is rejected (e.g. LAN origin open while
          // the push deep-links to the tailnet origin) — focusing is enough.
          try {
            await existing.navigate(url);
          } catch {
            /* keep the focused window as-is */
          }
        }
        return;
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(url || "/");
      }
    })(),
  );
});
