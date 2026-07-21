import { useCallback, useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  describeThisDevice,
  getCurrentPushSubscription,
  isWebPushSupported,
  subscribeToWebPush,
} from "~/lib/webPush";

/**
 * Per-device Web Push registration state and the enable/disable flows:
 * fetch the server's VAPID public key, subscribe this browser's PushManager,
 * and register/unregister the subscription with the server.
 */

export type WebPushDeviceStatus =
  | { readonly state: "unsupported" }
  | { readonly state: "permission-denied" }
  | { readonly state: "not-registered" }
  | { readonly state: "registered"; readonly endpoint: string }
  | { readonly state: "busy"; readonly operation: "enabling" | "disabling" };

export interface WebPushDevice {
  readonly status: WebPushDeviceStatus;
  readonly error: string | null;
  readonly enable: () => void;
  readonly disable: () => void;
}

function idleStatus(): WebPushDeviceStatus {
  return Notification.permission === "denied"
    ? { state: "permission-denied" }
    : { state: "not-registered" };
}

export function useWebPushDevice(environmentId: EnvironmentId | null): WebPushDevice {
  const getPublicKey = useAtomCommand(serverEnvironment.webPushGetPublicKey, "web push public key");
  const subscribeRpc = useAtomCommand(serverEnvironment.webPushSubscribe, "web push subscribe");
  const unsubscribeRpc = useAtomCommand(
    serverEnvironment.webPushUnsubscribe,
    "web push unsubscribe",
  );
  const [status, setStatus] = useState<WebPushDeviceStatus>(() =>
    isWebPushSupported() ? { state: "not-registered" } : { state: "unsupported" },
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isWebPushSupported()) return;
    let cancelled = false;
    void getCurrentPushSubscription()
      .then((subscription) => {
        if (cancelled) return;
        setStatus(
          subscription !== null
            ? { state: "registered", endpoint: subscription.endpoint }
            : idleStatus(),
        );
      })
      .catch(() => {
        /* stay at the optimistic initial state */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(() => {
    if (environmentId === null || !isWebPushSupported()) return;
    setError(null);
    setStatus({ state: "busy", operation: "enabling" });
    void (async () => {
      try {
        const keyResult = await getPublicKey({ environmentId, input: {} });
        if (keyResult._tag !== "Success") {
          throw new Error("Could not fetch the server's push key.");
        }
        const subscription = await subscribeToWebPush(keyResult.value.publicKey);
        const json = subscription.toJSON();
        if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
          await subscription.unsubscribe().catch(() => {});
          throw new Error("The browser returned an incomplete subscription.");
        }
        const registered = await subscribeRpc({
          environmentId,
          input: {
            subscription: {
              endpoint: json.endpoint,
              expirationTime: json.expirationTime ?? null,
              keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
            },
            deviceLabel: describeThisDevice(),
          },
        });
        if (registered._tag !== "Success") {
          // Roll back so a half-registered device cannot look enabled.
          await subscription.unsubscribe().catch(() => {});
          throw new Error("The server rejected the registration.");
        }
        setStatus({ state: "registered", endpoint: json.endpoint });
      } catch (cause) {
        console.warn("[WEB_PUSH] enable failed", cause);
        const message = cause instanceof Error && cause.message.length > 0 ? cause.message : null;
        setError(message ?? "Enabling Web Push failed.");
        setStatus(idleStatus());
      }
    })();
  }, [environmentId, getPublicKey, subscribeRpc]);

  const disable = useCallback(() => {
    if (environmentId === null || !isWebPushSupported()) return;
    setError(null);
    setStatus({ state: "busy", operation: "disabling" });
    void (async () => {
      try {
        const subscription = await getCurrentPushSubscription();
        if (subscription === null) {
          setStatus(idleStatus());
          return;
        }
        const removed = await unsubscribeRpc({
          environmentId,
          input: { endpoint: subscription.endpoint },
        });
        if (removed._tag !== "Success") {
          throw new Error("The server could not remove this device.");
        }
        await subscription.unsubscribe();
        setStatus(idleStatus());
      } catch (cause) {
        console.warn("[WEB_PUSH] disable failed", cause);
        const message = cause instanceof Error && cause.message.length > 0 ? cause.message : null;
        setError(message ?? "Disabling Web Push failed.");
        const subscription = await getCurrentPushSubscription().catch(() => null);
        setStatus(
          subscription !== null
            ? { state: "registered", endpoint: subscription.endpoint }
            : idleStatus(),
        );
      }
    })();
  }, [environmentId, unsubscribeRpc]);

  return { status, error, enable, disable };
}
