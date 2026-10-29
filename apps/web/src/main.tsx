import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";
// Fork-owned styles last so they can override upstream rules at equal
// specificity; kept out of index.css to avoid upstream merge conflicts.
import "./fork.css";

import { registerPushServiceWorker } from "./lib/webPush";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { isElectron } from "./env";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";

const router = startAppServices();

// Web Push (fork, roadmap #6): keep the push service worker registered so
// subscribed devices receive notifications with the app closed. No-ops in
// Electron and on insecure origins.
void registerPushServiceWorker();

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

let chunkLoadFailed = false;
let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  chunkLoadFailed = true;
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

const app = <AppRoot router={router} />;

// Split by runtime to keep Clerk out of local startup and clerk-js out of browser builds.
const managedAuthShellModule =
  clerkPublishableKey && hasCloudPublicConfig()
    ? isElectron
      ? import("./components/clerk/ElectronManagedAuthShell")
      : import("./components/clerk/BrowserManagedAuthShell")
    : null;

export const startup = Promise.all([
  managedAuthShellModule?.then((module) => module.default) ?? null,
  router.load(),
])
  .then(([ManagedAuthShell]) => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (reloadScheduled) return;
    if (!chunkLoadFailed) clearChunkReloadGuard();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        {ManagedAuthShell && clerkPublishableKey ? (
          <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
        ) : (
          app
        )}
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (reloadScheduled) return;
    throw error;
  });
