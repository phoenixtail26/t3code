// @effect-diagnostics nodeBuiltinImport:off - the fake Hearsay is a loopback node:http server.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as HearsaySpeech from "./HearsaySpeechService.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import * as Upstream from "./SpeechService.ts";

const { HEARSAY_RECOGNIZER_MODEL_ID } = HearsaySpeech;

const native = vi.hoisted(() => ({
  backend: "CPU",
  supportsStreaming: false,
  supportsLongForm: false,
  supportsTranslation: false,
  supportsVocabulary: false,
  languages: ["en"] as readonly string[],
  begin: vi.fn(async () => {}),
  feed: vi.fn(async () => ({ revision: 1, text: null })),
  finish: vi.fn(async () => "upstream heard it"),
  reset: vi.fn(async () => {}),
  dispose: vi.fn(),
  transcribe: vi.fn(async () => ({ text: "upstream heard it" })),
}));
const loadNative = vi.hoisted(() => vi.fn(async () => native));
const discoverGpus = vi.hoisted(() => vi.fn(async () => []));
vi.mock("./native.ts", () => ({
  loadNativeSpeechModel: loadNative,
  listNativeSpeechGpuDevices: discoverGpus,
}));

const store = Layer.succeed(
  SpeechModelStore.SpeechModelStore,
  SpeechModelStore.SpeechModelStore.of({
    isReady: () => Effect.succeed(true),
    installedPath: () => Effect.succeed("test.gguf"),
    download: () => Effect.succeed("test.gguf"),
    remove: () => Effect.void,
  }),
);

type Received = {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: Buffer;
};
type Reply = {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
};

/** A fake Hearsay: records every request and answers from `reply`. */
const fakeHearsay = Effect.acquireRelease(
  Effect.callback<{
    url: string;
    received: Received[];
    reply: (request: Received) => Reply;
    server: NodeHttp.Server;
  }>((resume) => {
    const received: Received[] = [];
    const state = {
      url: "",
      received,
      reply: (_request: Received): Reply => ({ status: 404, body: { error: "unexpected" } }),
      server: undefined as unknown as NodeHttp.Server,
    };
    const server = NodeHttp.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const entry = {
          method: request.method ?? "",
          url: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks),
        };
        received.push(entry);
        const reply = state.reply(entry);
        response.writeHead(reply.status, {
          "content-type": "application/json",
          ...reply.headers,
        });
        response.end(JSON.stringify(reply.body));
      });
    });
    state.server = server;
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") state.url = `http://127.0.0.1:${address.port}`;
      resume(Effect.succeed(state));
    });
  }),
  (state) =>
    Effect.callback<void>((resume) => {
      state.server.close(() => resume(Effect.void));
    }),
);

const statusBody = (
  state:
    | { state: "ready" }
    | { state: "downloading"; percent: number }
    | { state: "missing"; error?: string },
  extra: Record<string, unknown> = {},
) => ({
  models: { [HEARSAY_RECOGNIZER_MODEL_ID]: { ...state, size_bytes: 1000 } },
  loaded: [],
  failures: {},
  last: null,
  restart_needed: [],
  unavailable: {},
  ...extra,
});

const layerFor = (hearsay: { url?: string; token?: string }, base = HearsaySpeech.layer) =>
  base.pipe(
    Layer.provide(store),
    Layer.provideMerge(ServerSettings.layerTest({ hearsaySpeech: hearsay })),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeServices.layer),
  );

const float32 = (...samples: number[]) => new Uint8Array(new Float32Array(samples).buffer);
const int16Of = (bytes: Uint8Array) =>
  Array.from(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2));
const options = DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS;
const requests = (hearsay: { received: Received[] }) =>
  hearsay.received.map((request) => `${request.method} ${request.url}`);
const UPSTREAM_MODEL_ID = "handy-computer/parakeet-unified-en-0.6b-gguf";
const pollingAtOnce = (downloadCap: Duration.Duration) =>
  HearsaySpeech.layerWith({ downloadPoll: Duration.zero, downloadCap });

beforeEach(() => {
  loadNative.mockClear();
  discoverGpus.mockClear();
});

it("clips Float32 samples to [-1, 1] and encodes little-endian Int16", () => {
  const bytes = HearsaySpeech.float32ToInt16Pcm(new Float32Array([0, 0.5, 1, -1, 1.5, -2]));
  expect(bytes.byteLength).toBe(12);
  expect(bytes[2]).toBe(0x00);
  expect(bytes[3]).toBe(0x40);
  expect(int16Of(bytes)).toEqual([0, 16384, 32767, -32767, 32767, -32767]);
});

it.live("hands every call through to upstream when no URL is set", () =>
  Effect.gen(function* () {
    const hearsay = yield* fakeHearsay;
    const speech = yield* Upstream.SpeechService;
    const text = yield* speech.transcribe(float32(0.25), options);
    expect(text).toBe("upstream heard it");
    expect(loadNative).toHaveBeenCalledTimes(1);
    const status = yield* speech.status;
    expect(status.supported && status.modelId).toBe(UPSTREAM_MODEL_ID);
    const { models } = yield* speech.models(false);
    expect(models.map((model) => model.id)).toContain(UPSTREAM_MODEL_ID);
    const scope = yield* Scope.make();
    const stream = yield* speech.startStream(options).pipe(Scope.provide(scope));
    yield* stream.feed(float32(0.25));
    expect(yield* stream.finish).toBe("upstream heard it");
    yield* Scope.close(scope, Exit.void);
    expect(yield* speech.updateAcceleration("cpu")).toMatchObject({
      supported: true,
      modelId: UPSTREAM_MODEL_ID,
      acceleration: "cpu",
    });
    expect(discoverGpus).toHaveBeenCalled();
    expect(hearsay.received).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layerFor({}))),
);

it.live("posts Int16 PCM with the t3code source and answers Hearsay's text", () =>
  Effect.gen(function* () {
    const hearsay = yield* fakeHearsay;
    hearsay.reply = () => ({
      status: 200,
      body: { text: "T3 is ready", raw: "tee three is ready" },
      headers: { "hearsay-entry": "entry-1" },
    });
    const speech = yield* Upstream.SpeechService.pipe(
      Effect.provide(layerFor({ url: `${hearsay.url}/` })),
    );
    const logged: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logged.push(...(Array.isArray(message) ? message : [message]));
    });
    const text = yield* speech
      .transcribe(float32(0, 0.5, 1, -1), options)
      .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    expect(text).toBe("T3 is ready");
    expect(logged).toEqual([`speech: forwarded to Hearsay at ${hearsay.url}, entry entry-1`]);
    expect(loadNative).not.toHaveBeenCalled();
    expect(hearsay.received).toHaveLength(1);
    const request = hearsay.received[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/transcribe?source=t3code");
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.origin).toBeUndefined();
    expect(request.body.byteLength).toBe(8);
    expect(int16Of(new Uint8Array(request.body))).toEqual([0, 16384, 32767, -32767]);
  }).pipe(Effect.scoped),
);

it.live("sends the bearer token when one is set and delivers a suspect transcript as text", () =>
  Effect.gen(function* () {
    const hearsay = yield* fakeHearsay;
    hearsay.reply = () => ({
      status: 200,
      body: { text: "hm", raw: "hm", suspect: true, suspect_reason: "too short" },
    });
    const text = yield* Effect.gen(function* () {
      const speech = yield* Upstream.SpeechService;
      return yield* speech.transcribe(float32(0.25), options);
    }).pipe(Effect.provide(layerFor({ url: hearsay.url, token: "secret-token" })));
    expect(text).toBe("hm");
    expect(hearsay.received[0]!.headers.authorization).toBe("Bearer secret-token");
  }).pipe(Effect.scoped),
);

it.live("names the URL and Hearsay's reason when Hearsay answers 503", () =>
  Effect.gen(function* () {
    const hearsay = yield* fakeHearsay;
    hearsay.reply = () => ({ status: 503, body: { error: "engine failed to load" } });
    const exit = yield* Effect.gen(function* () {
      const speech = yield* Upstream.SpeechService;
      return yield* speech.transcribe(float32(0.25), options);
    }).pipe(Effect.provide(layerFor({ url: hearsay.url })), Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? exit.cause : undefined;
    expect(String(error)).toContain(
      `Hearsay at ${hearsay.url} did not answer: engine failed to load`,
    );
  }).pipe(Effect.scoped),
);

it.live("names the URL when the connection is refused", () =>
  Effect.gen(function* () {
    const hearsay = yield* fakeHearsay;
    const url = hearsay.url;
    yield* Effect.callback<void>((resume) => {
      hearsay.server.close(() => resume(Effect.void));
    });
    const exit = yield* Effect.gen(function* () {
      const speech = yield* Upstream.SpeechService;
      return yield* speech.transcribe(float32(0.25), options);
    }).pipe(Effect.provide(layerFor({ url })), Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
      `Hearsay at ${url} did not answer: `,
    );
    const status = yield* Effect.gen(function* () {
      const speech = yield* Upstream.SpeechService;
      return yield* speech.status;
    }).pipe(Effect.provide(layerFor({ url })));
    expect(status.supported).toBe(false);
    expect(!status.supported && status.reason).toContain(
      `Hearsay at ${url} did not answer: connect ECONNREFUSED`,
    );
  }).pipe(Effect.scoped),
);

it.live("maps Hearsay's model states onto upstream's status and model list", () =>
  Effect.gen(function* () {
    const hearsay = yield* fakeHearsay;
    const speech = yield* Upstream.SpeechService.pipe(
      Effect.provide(layerFor({ url: hearsay.url })),
    );

    hearsay.reply = () => ({ status: 200, body: statusBody({ state: "ready" }) });
    const ready = yield* speech.status;
    expect(ready).toMatchObject({
      supported: true,
      state: "ready",
      modelId: HEARSAY_RECOGNIZER_MODEL_ID,
      size: 1000,
      supportsStreaming: false,
      supportsBufferedStreaming: true,
    });
    const healthy = (yield* speech.models(false)).models;
    expect(healthy).toMatchObject([
      { id: HEARSAY_RECOGNIZER_MODEL_ID, state: "installed", active: true },
    ]);
    expect(healthy[0]?.description).not.toContain("last attempt failed");

    hearsay.reply = () => ({
      status: 200,
      body: statusBody({ state: "downloading", percent: 40 }),
    });
    expect(yield* speech.status).toMatchObject({ supported: true, state: "missing-model" });
    expect((yield* speech.models(false)).models).toMatchObject([
      { state: "downloading", downloaded: 400, active: false },
    ]);

    hearsay.reply = () => ({ status: 200, body: statusBody({ state: "missing" }) });
    expect(yield* speech.status).toMatchObject({ supported: true, state: "missing-model" });
    expect((yield* speech.models(false)).models).toMatchObject([{ state: "downloadable" }]);

    hearsay.reply = () => ({
      status: 200,
      body: statusBody({ state: "ready" }, { failures: { recognizer: "engine failed to load" } }),
    });
    expect(yield* speech.status).toMatchObject({ supported: true, state: "ready" });
    expect((yield* speech.models(false)).models[0]?.description).toContain(
      "Hearsay's last attempt failed: engine failed to load",
    );

    hearsay.reply = () => ({
      status: 200,
      body: statusBody(
        { state: "missing" },
        { unavailable: { recognizer: "install hearsay[stt]" } },
      ),
    });
    expect(yield* speech.status).toEqual({
      supported: false,
      reason: `Hearsay at ${hearsay.url}: install hearsay[stt]`,
    });
    hearsay.reply = () => ({
      status: 200,
      body: { ...statusBody({ state: "missing" }), models: { recognizer: { state: "ready" } } },
    });
    expect(yield* speech.status).toMatchObject({ supported: true, state: "ready", size: 0 });
    expect(yield* speech.updateAcceleration("cpu")).toMatchObject({
      supported: true,
      acceleration: "cpu",
    });
    expect(loadNative).not.toHaveBeenCalled();
    expect(discoverGpus).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

it.live("starts Hearsay's download and polls its status until the model landed", () =>
  Effect.gen(function* () {
    const hearsay = yield* fakeHearsay;
    const answers = [
      statusBody({ state: "downloading", percent: 10 }),
      statusBody({ state: "downloading", percent: 60 }),
      statusBody({ state: "ready" }),
    ];
    hearsay.reply = () => ({ status: 200, body: answers[hearsay.received.length - 1] });
    const speech = yield* Upstream.SpeechService.pipe(
      Effect.provide(layerFor({ url: hearsay.url }, pollingAtOnce(Duration.minutes(30)))),
    );
    const { models } = yield* speech.downloadModel(HEARSAY_RECOGNIZER_MODEL_ID);
    expect(models).toMatchObject([{ id: HEARSAY_RECOGNIZER_MODEL_ID, state: "installed" }]);
    expect(requests(hearsay)).toEqual([
      `POST /v1/models/${HEARSAY_RECOGNIZER_MODEL_ID}/download`,
      "GET /v1/status",
      "GET /v1/status",
    ]);
    const unknown = yield* speech.downloadModel("other-model").pipe(Effect.exit);
    expect(Exit.isFailure(unknown)).toBe(true);
    expect(hearsay.received).toHaveLength(3);
  }).pipe(Effect.scoped),
);

it.live("fails a download Hearsay reports as failed", () =>
  Effect.gen(function* () {
    const hearsay = yield* fakeHearsay;
    hearsay.reply = () => ({
      status: 200,
      body: statusBody({ state: "missing", error: "disk full" }),
    });
    const speech = yield* Upstream.SpeechService.pipe(
      Effect.provide(layerFor({ url: hearsay.url })),
    );
    const exit = yield* speech.downloadModel(HEARSAY_RECOGNIZER_MODEL_ID).pipe(Effect.exit);
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
      `Hearsay at ${hearsay.url} did not answer: disk full`,
    );
  }).pipe(Effect.scoped),
);

it.live("gives up on a download still running when its cap has passed", () =>
  Effect.gen(function* () {
    const hearsay = yield* fakeHearsay;
    hearsay.reply = () => ({
      status: 200,
      body: statusBody({ state: "downloading", percent: 1 }),
    });
    const speech = yield* Upstream.SpeechService.pipe(
      Effect.provide(layerFor({ url: hearsay.url }, pollingAtOnce(Duration.zero))),
    );
    const exit = yield* speech.downloadModel(HEARSAY_RECOGNIZER_MODEL_ID).pipe(Effect.exit);
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
      `Hearsay at ${hearsay.url} did not answer: the model download did not finish within`,
    );
    expect(requests(hearsay)).toEqual([`POST /v1/models/${HEARSAY_RECOGNIZER_MODEL_ID}/download`]);
  }).pipe(Effect.scoped),
);

it.live("cancels a download only while Hearsay says it is downloading", () =>
  Effect.gen(function* () {
    const hearsay = yield* fakeHearsay;
    const speech = yield* Upstream.SpeechService.pipe(
      Effect.provide(layerFor({ url: hearsay.url })),
    );
    hearsay.reply = (request) => ({
      status: 200,
      body: statusBody(
        request.method === "DELETE" ? { state: "missing" } : { state: "downloading", percent: 5 },
      ),
    });
    expect((yield* speech.cancelDownload(HEARSAY_RECOGNIZER_MODEL_ID)).models).toMatchObject([
      { state: "downloadable" },
    ]);
    expect(requests(hearsay)).toEqual([
      "GET /v1/status",
      `DELETE /v1/models/${HEARSAY_RECOGNIZER_MODEL_ID}`,
    ]);

    hearsay.reply = () => ({ status: 200, body: statusBody({ state: "ready" }) });
    expect((yield* speech.cancelDownload(HEARSAY_RECOGNIZER_MODEL_ID)).models).toMatchObject([
      { state: "installed" },
    ]);
    expect(requests(hearsay).slice(2)).toEqual(["GET /v1/status"]);
  }).pipe(Effect.scoped),
);

it.live("refuses to remove Hearsay's model and sends nothing", () =>
  Effect.gen(function* () {
    const hearsay = yield* fakeHearsay;
    const speech = yield* Upstream.SpeechService.pipe(
      Effect.provide(layerFor({ url: hearsay.url })),
    );
    const exit = yield* speech.removeModel(HEARSAY_RECOGNIZER_MODEL_ID).pipe(Effect.exit);
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
      "Remove Hearsay's models in Hearsay's settings window",
    );
    expect(hearsay.received).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live("refuses audio over five minutes without a request", () =>
  Effect.gen(function* () {
    const hearsay = yield* fakeHearsay;
    const speech = yield* Upstream.SpeechService.pipe(
      Effect.provide(layerFor({ url: hearsay.url })),
    );
    const exit = yield* speech
      .transcribe(new Uint8Array(HearsaySpeech.HEARSAY_MAX_PCM_BYTES * 2 + 4), options)
      .pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
      `Hearsay at ${hearsay.url} refused the recording: it is longer than five minutes`,
    );
    expect(hearsay.received).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live("collects streamed chunks and transcribes them together at finish", () =>
  Effect.gen(function* () {
    const hearsay = yield* fakeHearsay;
    hearsay.reply = () => ({ status: 200, body: { text: "all of it", raw: "all of it" } });
    const speech = yield* Upstream.SpeechService.pipe(
      Effect.provide(layerFor({ url: hearsay.url })),
    );
    const scope = yield* Scope.make();
    const stream = yield* speech.startStream(options).pipe(Scope.provide(scope));
    expect(yield* stream.feed(float32(0.5))).toEqual({ revision: 1, text: null });
    expect(yield* stream.feed(float32(-1, 1))).toEqual({ revision: 2, text: null });
    expect(yield* stream.finish).toBe("all of it");
    yield* Scope.close(scope, Exit.void);
    expect(hearsay.received).toHaveLength(1);
    expect(hearsay.received[0]!.url).toBe("/v1/transcribe?source=t3code");
    expect(int16Of(new Uint8Array(hearsay.received[0]!.body))).toEqual([16384, -32767, 32767]);
    expect(loadNative).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);
