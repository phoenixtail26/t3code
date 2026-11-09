import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { readPreparedConnection } from "../state/session";
import { speak } from "./api";

vi.mock(import("../state/session"), { spy: true });

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

it("stopping while the voice still loads ends the request, so the server can cancel", async () => {
  const target = new PrimaryConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "This computer",
    httpBaseUrl: window.location.origin,
    wsBaseUrl: "ws://localhost",
  });
  using _prepared = vi
    .mocked(readPreparedConnection)
    .mockReturnValue({ ...target, target, socketUrl: target.wsBaseUrl, httpAuthorization: null });
  // Hearsay has not sent `format`, so the route has not answered: the fetch stays pending.
  const requests: Array<{ url: string; init: RequestInit }> = [];
  using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
    (input, init) =>
      new Promise<Response>((_resolve, reject) => {
        requests.push({
          url: String(input instanceof Request ? input.url : input),
          init: init ?? {},
        });
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The request was stopped.", "AbortError")),
        );
      }),
  );
  let stop = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const result = speak({
    environmentId: ENVIRONMENT_ID,
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("reply-1"),
    stop: stopped,
    onFormat: () => expect.unreachable("no format arrived"),
    onChunk: () => expect.unreachable("no audio arrived"),
  });
  const speakRequest = () =>
    requests.find((request) => request.url.endsWith("/api/read-aloud/speak"));
  await vi.waitFor(() => expect(speakRequest()).toBeDefined());
  expect(speakRequest()!.init.signal?.aborted).toBe(false);
  stop();
  expect(await result).toEqual({ ok: true });
  expect(speakRequest()!.init.signal?.aborted).toBe(true);
});
