// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import type { PushNotificationSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import webpush from "web-push";

import { sendTestPushNotification } from "./PushNotifierService.ts";
import type { StoredWebPushSubscription, WebPushSnapshot } from "./WebPushStore.ts";

const settings = (overrides: Partial<PushNotificationSettings>): PushNotificationSettings => ({
  topicUrl: "",
  publicBaseUrl: "",
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnFailure: true,
  notifyOnCompletion: true,
  suppressWhenPresentSeconds: 300,
  ...overrides,
});

const emptyWebPush: WebPushSnapshot = { vapidKeys: Option.none(), subscriptions: [] };

const makeWebPushSnapshot = (endpoint: string): WebPushSnapshot => {
  const ecdh = NodeCrypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const subscription: StoredWebPushSubscription = {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey("base64url"),
      auth: NodeCrypto.randomBytes(16).toString("base64url"),
    },
    createdAtMs: 0,
  };
  return {
    vapidKeys: Option.some(webpush.generateVAPIDKeys()),
    subscriptions: [subscription],
  };
};

interface ReceivedRequest {
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

interface PushStub {
  readonly baseUrl: string;
  readonly received: ReadonlyArray<ReceivedRequest>;
}

const makePushStub = (status: number) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const received: Array<ReceivedRequest> = [];
      const server = NodeHttp.createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: string | Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          received.push({ headers: request.headers, body });
          response.writeHead(status);
          response.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as NodeNet.AddressInfo;
      return { server, stub: { baseUrl: `http://127.0.0.1:${port}`, received } };
    }),
    ({ server }) => Effect.promise(() => new Promise((resolve) => server.close(resolve))),
  ).pipe(Effect.map(({ stub }): PushStub => stub));

describe("sendTestPushNotification", () => {
  it.effect("short-circuits when no channel is configured", () =>
    Effect.gen(function* () {
      const result = yield* sendTestPushNotification(settings({}), emptyWebPush);
      expect(result).toEqual({
        sent: false,
        detail: "No topic URL configured and no Web Push devices registered.",
        goneEndpoints: [],
      });
    }),
  );

  it.effect("delivers the test push with ntfy headers and reports success", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stub = yield* makePushStub(200);
        const result = yield* sendTestPushNotification(
          settings({
            topicUrl: `${stub.baseUrl}/topic`,
            publicBaseUrl: "https://machine.tailnet.ts.net",
          }),
          emptyWebPush,
        );
        expect(result).toEqual({
          sent: true,
          detail: "ntfy: Delivered (HTTP 200).",
          goneEndpoints: [],
        });
        expect(stub.received).toHaveLength(1);
        expect(stub.received[0]?.headers["title"]).toBe("Test notification");
        expect(stub.received[0]?.headers["click"]).toBe("https://machine.tailnet.ts.net");
        expect(stub.received[0]?.body).toContain("configured correctly");
      }),
    ),
  );

  it.effect("omits the click header when no public base URL is set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stub = yield* makePushStub(200);
        yield* sendTestPushNotification(
          settings({ topicUrl: `${stub.baseUrl}/topic` }),
          emptyWebPush,
        );
        expect(stub.received[0]?.headers["click"]).toBeUndefined();
      }),
    ),
  );

  it.effect("reports a rejection status as a value, not an error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stub = yield* makePushStub(500);
        const result = yield* sendTestPushNotification(
          settings({ topicUrl: `${stub.baseUrl}/topic` }),
          emptyWebPush,
        );
        expect(result).toEqual({
          sent: false,
          detail: "ntfy: The push server rejected the request (HTTP 500).",
          goneEndpoints: [],
        });
      }),
    ),
  );

  it.effect("reports an unreachable topic URL as a value, not an error", () =>
    Effect.gen(function* () {
      // Port 9 (discard) refuses connections on Windows dev machines.
      const result = yield* sendTestPushNotification(
        settings({ topicUrl: "http://127.0.0.1:9/topic" }),
        emptyWebPush,
      );
      expect(result).toEqual({
        sent: false,
        detail: "ntfy: Could not reach the topic URL.",
        goneEndpoints: [],
      });
    }),
  );

  it.effect("delivers an encrypted VAPID-signed Web Push to a registered device", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stub = yield* makePushStub(201);
        const result = yield* sendTestPushNotification(
          settings({}),
          makeWebPushSnapshot(`${stub.baseUrl}/push/device-1`),
        );
        expect(result).toEqual({
          sent: true,
          detail: "Web Push: 1/1 delivered.",
          goneEndpoints: [],
        });
        expect(stub.received).toHaveLength(1);
        expect(stub.received[0]?.headers["authorization"]).toMatch(/^vapid t=/);
        expect(stub.received[0]?.headers["content-encoding"]).toBe("aes128gcm");
        // High urgency + a long TTL, or Doze defers the push and then the
        // push service silently drops it before the phone wakes.
        expect(stub.received[0]?.headers["urgency"]).toBe("high");
        expect(Number(stub.received[0]?.headers["ttl"])).toBeGreaterThanOrEqual(86_400);
        // The payload must be ciphertext, not the notification JSON.
        expect(stub.received[0]?.body).not.toContain("Test notification");
      }),
    ),
  );

  it.effect("marks a subscription gone when the push service returns 410", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stub = yield* makePushStub(410);
        const endpoint = `${stub.baseUrl}/push/device-1`;
        const result = yield* sendTestPushNotification(settings({}), makeWebPushSnapshot(endpoint));
        expect(result).toEqual({
          sent: false,
          detail: "Web Push: 0/1 delivered, 1 stale device removed.",
          goneEndpoints: [endpoint],
        });
      }),
    ),
  );

  it.effect("reports both channels when ntfy and Web Push are configured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stub = yield* makePushStub(200);
        const result = yield* sendTestPushNotification(
          settings({ topicUrl: `${stub.baseUrl}/topic` }),
          makeWebPushSnapshot(`${stub.baseUrl}/push/device-1`),
        );
        expect(result.sent).toBe(true);
        expect(result.detail).toBe("ntfy: Delivered (HTTP 200). · Web Push: 1/1 delivered.");
      }),
    ),
  );
});
