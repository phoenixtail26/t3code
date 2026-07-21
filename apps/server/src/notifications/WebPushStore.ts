import { WebPushError, type WebPushSubscriptionInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import webpush from "web-push";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/**
 * Server-side Web Push state: the VAPID keypair and the registered device
 * subscriptions. Lives in the `ServerSecretStore` (0700 secrets dir), NOT in
 * `settings.json` — the private key must never ride the settings RPCs, and a
 * subscription endpoint is a bearer capability for pushing to that device.
 */

const SECRET_NAME = "web-push-store";

export const VapidKeys = Schema.Struct({
  publicKey: Schema.String,
  privateKey: Schema.String,
});
export type VapidKeys = typeof VapidKeys.Type;

export const StoredWebPushSubscription = Schema.Struct({
  endpoint: Schema.String,
  expirationTime: Schema.optional(Schema.NullOr(Schema.Number)),
  keys: Schema.Struct({ p256dh: Schema.String, auth: Schema.String }),
  deviceLabel: Schema.optional(Schema.String),
  createdAtMs: Schema.Number,
});
export type StoredWebPushSubscription = typeof StoredWebPushSubscription.Type;

const WebPushStoreFile = Schema.Struct({
  vapidKeys: Schema.optional(VapidKeys),
  subscriptions: Schema.Array(StoredWebPushSubscription).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
type WebPushStoreFile = typeof WebPushStoreFile.Type;

const decodeStoreFile = Schema.decodeUnknownExit(fromLenientJson(WebPushStoreFile));
const encodeStoreFileJson = Schema.encodeUnknownEffect(fromJsonStringPretty(WebPushStoreFile));

const EMPTY_STORE: WebPushStoreFile = { subscriptions: [] };

export interface WebPushSnapshot {
  readonly vapidKeys: Option.Option<VapidKeys>;
  readonly subscriptions: ReadonlyArray<StoredWebPushSubscription>;
}

export class WebPushStore extends Context.Service<
  WebPushStore,
  {
    /** VAPID public key for `pushManager.subscribe`; generated on first call. */
    readonly getPublicKey: Effect.Effect<string, WebPushError>;
    readonly subscribe: (input: {
      readonly subscription: WebPushSubscriptionInput;
      readonly deviceLabel?: string | undefined;
    }) => Effect.Effect<{ readonly subscriptionCount: number }, WebPushError>;
    readonly unsubscribe: (
      endpoint: string,
    ) => Effect.Effect<
      { readonly removed: boolean; readonly subscriptionCount: number },
      WebPushError
    >;
    /** Keys + subscriptions in one read, for the delivery path. */
    readonly snapshot: Effect.Effect<WebPushSnapshot, WebPushError>;
    /** Cheap gate for the notifier's hot path (cached after first load). */
    readonly hasSubscriptions: Effect.Effect<boolean, WebPushError>;
    /** Drop subscriptions the push service reported gone (404/410). */
    readonly prune: (endpoints: ReadonlyArray<string>) => Effect.Effect<void, WebPushError>;
  }
>()("t3/notifications/WebPushStore") {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const writeSemaphore = yield* Semaphore.make(1);
  const stateRef = yield* Ref.make<Option.Option<WebPushStoreFile>>(Option.none());

  const loadFromDisk = Effect.gen(function* () {
    const raw = yield* secretStore
      .get(SECRET_NAME)
      .pipe(Effect.mapError((cause) => new WebPushError({ operation: "load-store", cause })));
    if (Option.isNone(raw)) return EMPTY_STORE;
    const decoded = decodeStoreFile(textDecoder.decode(raw.value));
    if (decoded._tag === "Failure") {
      // A corrupt store is recoverable: devices re-register on next use.
      yield* Effect.logWarning("failed to parse web push store, starting empty", {
        cause: decoded.cause,
      });
      return EMPTY_STORE;
    }
    return decoded.value;
  });

  const getState = Effect.gen(function* () {
    const cached = yield* Ref.get(stateRef);
    if (Option.isSome(cached)) return cached.value;
    const loaded = yield* loadFromDisk;
    yield* Ref.set(stateRef, Option.some(loaded));
    return loaded;
  });

  const persist = (next: WebPushStoreFile) =>
    Effect.gen(function* () {
      const raw = yield* encodeStoreFileJson(next).pipe(
        Effect.mapError((cause) => new WebPushError({ operation: "persist-store", cause })),
      );
      yield* secretStore
        .set(SECRET_NAME, textEncoder.encode(raw))
        .pipe(Effect.mapError((cause) => new WebPushError({ operation: "persist-store", cause })));
      yield* Ref.set(stateRef, Option.some(next));
    });

  const withStore = <A>(
    update: (
      current: WebPushStoreFile,
    ) => Effect.Effect<
      { readonly next: WebPushStoreFile | null; readonly result: A },
      WebPushError
    >,
  ): Effect.Effect<A, WebPushError> =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* getState;
        const { next, result } = yield* update(current);
        if (next !== null) yield* persist(next);
        return result;
      }),
    );

  const getPublicKey = withStore((current) =>
    Effect.gen(function* () {
      if (current.vapidKeys !== undefined) {
        return { next: null, result: current.vapidKeys.publicKey };
      }
      const generated = yield* Effect.try({
        try: () => webpush.generateVAPIDKeys(),
        catch: (cause) => new WebPushError({ operation: "generate-keys", cause }),
      });
      return {
        next: { ...current, vapidKeys: generated },
        result: generated.publicKey,
      };
    }),
  );

  const subscribe: WebPushStore["Service"]["subscribe"] = (input) =>
    withStore((current) =>
      Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const entry: StoredWebPushSubscription = {
          endpoint: input.subscription.endpoint,
          ...(input.subscription.expirationTime !== undefined
            ? { expirationTime: input.subscription.expirationTime }
            : {}),
          keys: input.subscription.keys,
          ...(input.deviceLabel !== undefined ? { deviceLabel: input.deviceLabel } : {}),
          createdAtMs: nowMs,
        };
        const subscriptions = [
          ...current.subscriptions.filter((s) => s.endpoint !== entry.endpoint),
          entry,
        ];
        return {
          next: { ...current, subscriptions },
          result: { subscriptionCount: subscriptions.length },
        };
      }),
    );

  const unsubscribe: WebPushStore["Service"]["unsubscribe"] = (endpoint) =>
    withStore((current) => {
      const subscriptions = current.subscriptions.filter((s) => s.endpoint !== endpoint);
      const removed = subscriptions.length !== current.subscriptions.length;
      return Effect.succeed({
        next: removed ? { ...current, subscriptions } : null,
        result: { removed, subscriptionCount: subscriptions.length },
      });
    });

  const prune: WebPushStore["Service"]["prune"] = (endpoints) =>
    endpoints.length === 0
      ? Effect.void
      : withStore((current) => {
          const gone = new Set(endpoints);
          const subscriptions = current.subscriptions.filter((s) => !gone.has(s.endpoint));
          return Effect.succeed({
            next:
              subscriptions.length !== current.subscriptions.length
                ? { ...current, subscriptions }
                : null,
            result: undefined,
          });
        });

  const snapshot: WebPushStore["Service"]["snapshot"] = Effect.map(getState, (state) => ({
    vapidKeys: Option.fromNullishOr(state.vapidKeys),
    subscriptions: state.subscriptions,
  }));

  const hasSubscriptions = Effect.map(getState, (state) => state.subscriptions.length > 0);

  return WebPushStore.of({
    getPublicKey,
    subscribe,
    unsubscribe,
    snapshot,
    hasSubscriptions,
    prune,
  });
});

export const layer = Layer.effect(WebPushStore, make);
