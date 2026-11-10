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

function prepared() {
  const target = new PrimaryConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "This computer",
    httpBaseUrl: window.location.origin,
    wsBaseUrl: "ws://localhost",
  });
  return vi
    .mocked(readPreparedConnection)
    .mockReturnValue({ ...target, target, socketUrl: target.wsBaseUrl, httpAuthorization: null });
}

/** A real streamed `Response` for the route, in two chunks, with only the headers given. */
function servedStream(bytes: Uint8Array, headers: Record<string, string> = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const split = Math.min(5, bytes.byteLength);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, split));
        if (split < bytes.byteLength) controller.enqueue(bytes.subarray(split));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream", ...headers },
    });
  });
}

const ratePrefix = (rate: number) => {
  const prefix = new Uint8Array(8);
  prefix.set([0x52, 0x41, 0x50, 0x43]);
  new DataView(prefix.buffer).setUint32(4, rate, true);
  return prefix;
};

async function speakServed(bytes: Uint8Array, headers?: Record<string, string>) {
  using _prepared = prepared();
  using _fetch = servedStream(bytes, headers);
  const formats: number[] = [];
  const pcm: number[] = [];
  const result = await speak({
    environmentId: ENVIRONMENT_ID,
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("reply-1"),
    stop: new Promise<void>(() => {}),
    onFormat: (rate) => formats.push(rate),
    onChunk: (chunk) => pcm.push(...chunk),
  });
  return { result, formats, pcm };
}

it("reads the rate from the stream's prefix when the header is not exposed", async () => {
  const served = await speakServed(new Uint8Array([...ratePrefix(22_050), 1, 0, 2, 0, 3, 0]));
  expect(served).toEqual({ result: { ok: true }, formats: [22_050], pcm: [1, 0, 2, 0, 3, 0] });
});

it("a stream with neither prefix nor header fails with the plain sentence", async () => {
  const served = await speakServed(new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0, 5, 0]));
  expect(served).toEqual({
    result: { ok: false, error: "The speech stream did not say its sample rate." },
    formats: [],
    pcm: [],
  });
});
