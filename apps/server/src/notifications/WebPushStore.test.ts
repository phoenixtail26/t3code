import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as WebPushStore from "./WebPushStore.ts";

/** In-memory secret store shared across service rebuilds to test persistence. */
const makeSecretStoreLayer = (secrets: Map<string, Uint8Array>) =>
  Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: (name) => Effect.succeed(Option.fromNullishOr(secrets.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        secrets.set(name, value);
      }),
  });

const subscription = (endpoint: string) => ({
  subscription: {
    endpoint,
    keys: { p256dh: "p256dh-key", auth: "auth-secret" },
  },
});

describe("WebPushStore", () => {
  it.effect("generates VAPID keys once and persists them across rebuilds", () =>
    Effect.gen(function* () {
      const secrets = new Map<string, Uint8Array>();
      const layer = makeSecretStoreLayer(secrets);

      const first = yield* WebPushStore.make.pipe(Effect.provide(layer));
      const publicKey = yield* first.getPublicKey;
      expect(publicKey.length).toBeGreaterThan(20);
      expect(yield* first.getPublicKey).toBe(publicKey);

      // A fresh service over the same secrets must see the same keypair.
      const second = yield* WebPushStore.make.pipe(Effect.provide(layer));
      expect(yield* second.getPublicKey).toBe(publicKey);
    }),
  );

  it.effect("upserts subscriptions by endpoint and unsubscribes cleanly", () =>
    Effect.gen(function* () {
      const store = yield* WebPushStore.make.pipe(Effect.provide(makeSecretStoreLayer(new Map())));

      expect(yield* store.hasSubscriptions).toBe(false);
      expect((yield* store.subscribe(subscription("https://push/a"))).subscriptionCount).toBe(1);
      expect((yield* store.subscribe(subscription("https://push/b"))).subscriptionCount).toBe(2);
      // Same endpoint again: replaced, not duplicated.
      expect((yield* store.subscribe(subscription("https://push/a"))).subscriptionCount).toBe(2);
      expect(yield* store.hasSubscriptions).toBe(true);

      expect(yield* store.unsubscribe("https://push/a")).toEqual({
        removed: true,
        subscriptionCount: 1,
      });
      expect(yield* store.unsubscribe("https://push/a")).toEqual({
        removed: false,
        subscriptionCount: 1,
      });
    }),
  );

  it.effect("prunes only the listed endpoints and persists the result", () =>
    Effect.gen(function* () {
      const secrets = new Map<string, Uint8Array>();
      const layer = makeSecretStoreLayer(secrets);
      const store = yield* WebPushStore.make.pipe(Effect.provide(layer));

      yield* store.subscribe(subscription("https://push/a"));
      yield* store.subscribe(subscription("https://push/b"));
      yield* store.prune(["https://push/a", "https://push/unknown"]);

      const snapshot = yield* store.snapshot;
      expect(snapshot.subscriptions.map((entry) => entry.endpoint)).toEqual(["https://push/b"]);

      const rebuilt = yield* WebPushStore.make.pipe(Effect.provide(layer));
      const persisted = yield* rebuilt.snapshot;
      expect(persisted.subscriptions.map((entry) => entry.endpoint)).toEqual(["https://push/b"]);
    }),
  );
});
