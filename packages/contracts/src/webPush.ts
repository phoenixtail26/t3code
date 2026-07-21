import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/**
 * Web Push to the installed PWA (fork feature, roadmap #6): the server
 * delivers notifications straight to a browser push service using VAPID,
 * removing the ntfy hop for subscribed devices. ntfy remains the fallback
 * channel for platforms where Web Push is unreliable.
 *
 * Only the VAPID *public* key and each device's own subscription payload
 * cross this boundary. The private key and the stored subscription list
 * (whose endpoints are bearer capabilities) stay server-side.
 */

export const WebPushSubscriptionKeys = Schema.Struct({
  p256dh: TrimmedNonEmptyString,
  auth: TrimmedNonEmptyString,
});
export type WebPushSubscriptionKeys = typeof WebPushSubscriptionKeys.Type;

/** Serialized `PushSubscription.toJSON()` as produced by the browser. */
export const WebPushSubscriptionInput = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
  expirationTime: Schema.optional(Schema.NullOr(Schema.Number)),
  keys: WebPushSubscriptionKeys,
});
export type WebPushSubscriptionInput = typeof WebPushSubscriptionInput.Type;

export const WebPushOperation = Schema.Literals([
  "load-store",
  "persist-store",
  "generate-keys",
  "encode-request",
]);
export type WebPushOperation = typeof WebPushOperation.Type;

export class WebPushError extends Schema.TaggedErrorClass<WebPushError>()("WebPushError", {
  operation: WebPushOperation,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Web push ${this.operation} failed.`;
  }
}

/**
 * Payload the server encrypts into each push message; the service worker
 * decodes it and renders a notification. Keep this shape in sync with
 * `apps/web/public/sw.js`, which cannot import from this package.
 */
export const WebPushMessagePayload = Schema.Struct({
  title: TrimmedNonEmptyString,
  body: Schema.String,
  /** Absolute click-through URL; empty when no publicBaseUrl is configured. */
  url: TrimmedString,
  /** Coalescing key so repeated pushes for one thread replace, not stack. */
  tag: TrimmedString,
});
export type WebPushMessagePayload = typeof WebPushMessagePayload.Type;
