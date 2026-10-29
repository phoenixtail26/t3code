import { WebPushError, type WebPushMessagePayload } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import webpush from "web-push";

import type { StoredWebPushSubscription, VapidKeys } from "./WebPushStore.ts";

/**
 * Web Push delivery. `web-push` supplies only the crypto (VAPID signing, payload
 * encryption); the POST goes through the Effect HttpClient so tests can intercept it.
 */

const REQUEST_TIMEOUT_MS = 10_000;
/**
 * How long the push service may hold an undelivered message (seconds). A
 * dozing phone can defer delivery for hours; a message that expires in the
 * meantime is silently dropped, so this must comfortably outlast a night of
 * Doze. 24 hours.
 */
const PUSH_TTL_SECONDS = 86_400;

export interface WebPushDeliveryResult {
  readonly endpoint: string;
  readonly outcome: "delivered" | "rejected" | "timeout" | "unreachable" | "encoding-failed";
  readonly status?: number;
  /** The push service says this subscription no longer exists — prune it. */
  readonly gone: boolean;
}

/**
 * VAPID `sub` claim: a contact URL for the push service operator. The public
 * base URL is the natural value when configured; the mailto fallback keeps
 * the claim syntactically valid when it is not.
 */
export const vapidSubjectFor = (publicBaseUrl: string): string =>
  publicBaseUrl.startsWith("https://") ? publicBaseUrl : "mailto:push@t3code.invalid";

const generateRequestDetails = (input: {
  readonly subscription: StoredWebPushSubscription;
  readonly vapidKeys: VapidKeys;
  readonly vapidSubject: string;
  readonly payloadJson: string;
}) =>
  Effect.try({
    try: () =>
      webpush.generateRequestDetails(
        {
          endpoint: input.subscription.endpoint,
          keys: input.subscription.keys,
        },
        input.payloadJson,
        {
          vapidDetails: {
            subject: input.vapidSubject,
            publicKey: input.vapidKeys.publicKey,
            privateKey: input.vapidKeys.privateKey,
          },
          TTL: PUSH_TTL_SECONDS,
          // Always high: FCM only wakes a dozing phone for high-urgency
          // messages, and presence suppression already guarantees a push
          // fires only when the user is away — every push is wake-worthy.
          urgency: "high",
        },
      ),
    catch: (cause) => new WebPushError({ operation: "encode-request", cause }),
  });

const sendToSubscription = Effect.fn("WebPushSender.sendToSubscription")(function* (input: {
  readonly subscription: StoredWebPushSubscription;
  readonly vapidKeys: VapidKeys;
  readonly vapidSubject: string;
  readonly payloadJson: string;
}) {
  const endpoint = input.subscription.endpoint;
  const details = yield* generateRequestDetails(input).pipe(Effect.option);
  if (Option.isNone(details)) {
    return { endpoint, outcome: "encoding-failed", gone: false } as const;
  }

  // Content-Length is dropped: the transport computes it from the body.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(details.value.headers)) {
    if (name.toLowerCase() === "content-length") continue;
    headers[name] = String(value);
  }

  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.post(details.value.endpoint).pipe(
    HttpClientRequest.setHeaders(headers),
    HttpClientRequest.bodyUint8Array(Uint8Array.from(details.value.body)),
  );
  return yield* client.execute(request).pipe(
    Effect.timeoutOption(REQUEST_TIMEOUT_MS),
    Effect.map((response): WebPushDeliveryResult => {
      if (Option.isNone(response)) {
        return { endpoint, outcome: "timeout", gone: false };
      }
      const status = response.value.status;
      if (status >= 200 && status < 300) {
        return { endpoint, outcome: "delivered", status, gone: false };
      }
      return {
        endpoint,
        outcome: "rejected",
        status,
        gone: status === 404 || status === 410,
      };
    }),
    Effect.orElseSucceed((): WebPushDeliveryResult => ({
      endpoint,
      outcome: "unreachable",
      gone: false,
    })),
  );
});

export const sendWebPushNotifications = (input: {
  readonly vapidKeys: VapidKeys;
  readonly vapidSubject: string;
  readonly payload: WebPushMessagePayload;
  readonly subscriptions: ReadonlyArray<StoredWebPushSubscription>;
}): Effect.Effect<ReadonlyArray<WebPushDeliveryResult>> => {
  const payloadJson = JSON.stringify(input.payload);
  return Effect.forEach(
    input.subscriptions,
    (subscription) =>
      sendToSubscription({
        subscription,
        vapidKeys: input.vapidKeys,
        vapidSubject: input.vapidSubject,
        payloadJson,
      }),
    { concurrency: 4 },
  ).pipe(Effect.provide(FetchHttpClient.layer));
};
