// @effect-diagnostics globalJsonInEffect:off nodeBuiltinImport:off - a test fixture on its own loopback server, writing Hearsay's small JSON messages by hand.
// Test fixture: an in-process Hearsay `WS /v1/speak` that records the handshake and the
// messages it is sent, and answers from a script. It runs its own server, so a test can
// serve a T3 route beside it.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";

export interface FakeHearsayScript {
  readonly sampleRate?: number;
  /** Waited for before `format`, as a voice still loading would. */
  readonly holdFormat?: Deferred.Deferred<void>;
  readonly chunks?: ReadonlyArray<Uint8Array>;
  /** Waited for after the first chunk, so a test can act while the speech is under way. */
  readonly gate?: Deferred.Deferred<void>;
  /** Sent in place of `done`, then the socket closes 1011. */
  readonly error?: string;
  /** Close with this code after the chunks instead of sending `done`. */
  readonly closeAfterChunks?: number;
  /** Refuse the handshake, as Hearsay does for a web origin. */
  readonly refuse?: boolean;
}

interface FakeHearsay {
  url: string;
  readonly handshakes: Array<Record<string, string | undefined>>;
  readonly received: Array<Record<string, unknown>>;
  /** Called with each message as it arrives. */
  onMessage: (message: Record<string, unknown>) => void;
  readonly cancelled: Deferred.Deferred<void>;
  /** Resolves once `done` has been sent. */
  readonly finished: Deferred.Deferred<void>;
}

/** Serves the fake on a loopback port for the scope's life. */
export const fakeHearsay = Effect.fn("test.fakeHearsay")(function* (
  script: FakeHearsayScript = {},
) {
  const state: FakeHearsay = {
    url: "",
    handshakes: [],
    received: [],
    onMessage: () => {},
    cancelled: yield* Deferred.make<void>(),
    finished: yield* Deferred.make<void>(),
  };
  const chunks = script.chunks ?? [new Uint8Array([1, 0, 2, 0])];
  const respond = Effect.fn("test.fakeHearsay.respond")(function* (writer: Socket.Writer) {
    if (script.holdFormat) yield* Deferred.await(script.holdFormat);
    yield* writer.write(
      JSON.stringify({ type: "format", sample_rate: script.sampleRate ?? 24_000 }),
    );
    for (const [index, chunk] of chunks.entries()) {
      yield* writer.write(chunk);
      if (index === 0 && script.gate) yield* Deferred.await(script.gate);
    }
    if (script.error !== undefined) {
      yield* writer.write(JSON.stringify({ type: "error", message: script.error }));
      yield* writer.write(new Socket.CloseEvent(1011));
      return;
    }
    if (script.closeAfterChunks !== undefined) {
      yield* writer.write(new Socket.CloseEvent(script.closeAfterChunks));
      return;
    }
    yield* writer.write(JSON.stringify({ type: "done" }));
    yield* Deferred.succeed(state.finished, undefined);
    yield* writer.write(new Socket.CloseEvent(1000));
  });
  const routes = HttpRouter.add(
    "GET",
    "/v1/speak",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      state.handshakes.push({ ...request.headers });
      if (script.refuse) return HttpServerResponse.empty({ status: 403 });
      const socket = yield* request.upgrade;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const writer = yield* socket.writer;
          const reader = yield* socket.reader;
          while (true) {
            for (const frame of yield* reader.pull) {
              if (typeof frame !== "string") continue;
              const message = JSON.parse(frame) as Record<string, unknown>;
              state.received.push(message);
              state.onMessage(message);
              if (message.type === "end") yield* respond(writer).pipe(Effect.forkScoped);
              if (message.type === "cancel") {
                yield* Deferred.succeed(state.cancelled, undefined);
                yield* writer.write(new Socket.CloseEvent(1000));
                return;
              }
            }
          }
        }).pipe(Effect.ignore),
      );
      return HttpServerResponse.empty();
    }),
  );
  const serverContext = yield* Layer.build(
    NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
  );
  yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }),
  ).pipe(Effect.provide(serverContext));
  const server = Context.get(serverContext, HttpServer.HttpServer);
  const address = server.address as NetAddress.InetAddress;
  const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
  state.url = `http://${host}:${address.port}`;
  return state;
});
