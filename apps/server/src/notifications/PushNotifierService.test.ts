// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";

import type { PushNotificationSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { sendTestPushNotification } from "./PushNotifierService.ts";

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

interface ReceivedRequest {
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

async function withNtfyStub(
  status: number,
  run: (topicUrl: string, received: ReadonlyArray<ReceivedRequest>) => Promise<void>,
): Promise<void> {
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
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/topic`, received);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("sendTestPushNotification", () => {
  it("short-circuits when no topic URL is configured", async () => {
    const result = await Effect.runPromise(sendTestPushNotification(settings({})));
    expect(result).toEqual({ sent: false, detail: "No topic URL configured." });
  });

  it("delivers the test push with ntfy headers and reports success", async () => {
    await withNtfyStub(200, async (topicUrl, received) => {
      const result = await Effect.runPromise(
        sendTestPushNotification(
          settings({ topicUrl, publicBaseUrl: "https://machine.tailnet.ts.net" }),
        ),
      );
      expect(result).toEqual({ sent: true, detail: "Delivered (HTTP 200)." });
      expect(received).toHaveLength(1);
      expect(received[0]?.headers["title"]).toBe("Test notification");
      expect(received[0]?.headers["click"]).toBe("https://machine.tailnet.ts.net");
      expect(received[0]?.body).toContain("configured correctly");
    });
  });

  it("omits the click header when no public base URL is set", async () => {
    await withNtfyStub(200, async (topicUrl, received) => {
      await Effect.runPromise(sendTestPushNotification(settings({ topicUrl })));
      expect(received[0]?.headers["click"]).toBeUndefined();
    });
  });

  it("reports a rejection status as a value, not an error", async () => {
    await withNtfyStub(500, async (topicUrl) => {
      const result = await Effect.runPromise(sendTestPushNotification(settings({ topicUrl })));
      expect(result).toEqual({
        sent: false,
        detail: "The push server rejected the request (HTTP 500).",
      });
    });
  });

  it("reports an unreachable topic URL as a value, not an error", async () => {
    // Port 9 (discard) refuses connections on Windows dev machines.
    const result = await Effect.runPromise(
      sendTestPushNotification(settings({ topicUrl: "http://127.0.0.1:9/topic" })),
    );
    expect(result).toEqual({ sent: false, detail: "Could not reach the topic URL." });
  });
});
