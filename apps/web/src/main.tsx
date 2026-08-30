import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider as ElectronClerkProvider } from "@clerk/electron/react";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";
// Fork-owned styles last so they can override upstream rules at equal
// specificity; kept out of index.css to avoid upstream merge conflicts.
import "./fork.css";

import { isElectron } from "./env";
import { registerPushServiceWorker } from "./lib/webPush";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import { clerkAppearance } from "./components/clerk/clerkAppearance";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

// Web Push (fork, roadmap #6): keep the push service worker registered so
// subscribed devices receive notifications with the app closed. No-ops in
// Electron and on insecure origins.
void registerPushServiceWorker();

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

const app = <AppRoot router={router} />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {clerkPublishableKey && hasCloudPublicConfig() ? (
      isElectron ? (
        <ElectronClerkProvider
          appearance={clerkAppearance}
          publishableKey={clerkPublishableKey}
          passkeys={passkeys}
        >
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ElectronClerkProvider>
      ) : (
        <ClerkProvider appearance={clerkAppearance} publishableKey={clerkPublishableKey}>
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ClerkProvider>
      )
    ) : (
      app
    )}
  </React.StrictMode>,
);
