// @effect-diagnostics nodeBuiltinImport:off -- the worker is a Node child process with an IPC channel, and its child side runs outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { TranscribeModel } from "transcribe-cpp";

type Engine = typeof import("transcribe-cpp");

type WorkerCommand =
  | { readonly kind: "load"; readonly path: string }
  | { readonly kind: "transcribe"; readonly pcm: Int16Array };

type WorkerRequest = WorkerCommand & { readonly id: number };

type WorkerReply =
  | { readonly id: number; readonly ok: true; readonly text?: string; readonly backend?: string }
  | { readonly id: number; readonly ok: false; readonly error: string };

// Child side: the npm bundle runs `dictation-worker.mjs`, the single executable
// its `__dictation-worker` subcommand. The model lives here so a native crash
// cannot take the server down. Nothing may run on import: in the executable
// `import.meta.main` is true for the whole bundle.

const LIBRARY_FILE = /^(lib)?transcribe\.(dll|so|dylib)$/u;

async function loadEngine(): Promise<Engine> {
  // The package only exports an `import` condition. Inside a single executable
  // `import()` resolves built-ins only, so its entry is required from disk.
  const engine: Engine = NodeSea.isSea()
    ? (() => {
        const packageJson = NodeModule.findPackageJSON("transcribe-cpp", import.meta.url);
        if (!packageJson) throw new Error("The transcribe-cpp package is not installed.");
        return NodeModule.createRequire(packageJson)(
          NodePath.join(NodePath.dirname(packageJson), "dist/index.js"),
        ) as Engine;
      })()
    : await import("transcribe-cpp");
  // In the desktop app the package sits inside server.asar. Its loader finds
  // the native library there, but the OS cannot load a DLL from inside an
  // archive; the packaged copy lives in server.asar.unpacked.
  if (!process.env.TRANSCRIBE_LIBRARY) {
    const directory = engine.artifactDir();
    const inArchive = `.asar${NodePath.sep}`;
    if (directory.includes(inArchive)) {
      const unpacked = directory.replace(inArchive, `.asar.unpacked${NodePath.sep}`);
      // Without the unpacked copy the engine's own loader reports the failure.
      const library = NodeFS.existsSync(unpacked)
        ? NodeFS.readdirSync(unpacked).find((file) => LIBRARY_FILE.test(file))
        : undefined;
      if (library) process.env.TRANSCRIBE_LIBRARY = NodePath.join(unpacked, library);
    }
  }
  return engine;
}

/** Transcribes, halving the audio when the engine reports it too long for one pass. */
async function transcribeAll(model: TranscribeModel, samples: Float32Array): Promise<string> {
  try {
    return (await model.transcribe(samples, {})).text.trim();
  } catch (error) {
    const name = error instanceof Error ? error.constructor.name : "";
    if ((name !== "InputTooLong" && name !== "OutputTruncated") || samples.length < 32_000) {
      throw error;
    }
    const middle = Math.floor(samples.length / 2);
    const first = await transcribeAll(model, samples.subarray(0, middle));
    const second = await transcribeAll(model, samples.subarray(middle));
    return `${first} ${second}`.trim();
  }
}

export async function runDictationWorker(): Promise<void> {
  const send = process.send?.bind(process);
  if (!send) throw new Error("The dictation worker needs an IPC channel.");
  let model: TranscribeModel | undefined;
  const handle = async (request: WorkerRequest): Promise<WorkerReply> => {
    if (request.kind === "load") {
      const engine = await loadEngine();
      model = await engine.TranscribeModel.load(request.path);
      return { id: request.id, ok: true, backend: model.backend };
    }
    if (!model) throw new Error("The dictation model is not loaded.");
    const samples = new Float32Array(request.pcm.length);
    for (let index = 0; index < samples.length; index++) {
      samples[index] = (request.pcm[index] ?? 0) / 32_768;
    }
    return { id: request.id, ok: true, text: await transcribeAll(model, samples) };
  };
  process.on("message", (request: WorkerRequest) => {
    void handle(request).then(
      (reply) => send(reply),
      (error: unknown) =>
        send({
          id: request.id,
          ok: false,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        } satisfies WorkerReply),
    );
  });
  process.on("disconnect", () => process.exit(0));
}

// Server side.

export class DictationWorkerError extends Schema.TaggedError<DictationWorkerError>()(
  "DictationWorkerError",
  {
    stage: Schema.Literals(["spawn", "load", "transcribe", "exited"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "spawn":
        return "The dictation engine could not start.";
      case "load":
        return "The dictation model could not be loaded.";
      case "transcribe":
        return "Transcription failed.";
      case "exited":
        return "The dictation engine stopped unexpectedly.";
    }
  }
}

/** A running worker with its model loaded. Requests must not overlap. */
export interface DictationWorkerProcess {
  readonly backend: string;
  readonly transcribe: (pcm: Int16Array) => Effect.Effect<string, DictationWorkerError>;
  /** Stops the process and waits for it to exit, so its model file is released. */
  readonly kill: Effect.Effect<void>;
}

export class DictationWorker extends Context.Service<
  DictationWorker,
  {
    /** Starts a worker process and loads the model into it. */
    readonly spawn: (
      modelPath: string,
    ) => Effect.Effect<DictationWorkerProcess, DictationWorkerError>;
  }
>()("t3/dictation/worker/DictationWorker") {}

const STDERR_TAIL_CHARS = 4_096;

function workerArgs(isExecutable: boolean): ReadonlyArray<string> {
  if (isExecutable) return ["__dictation-worker"];
  // From source this module is src/dictation/worker.ts; bundled, every chunk
  // sits in dist/ beside dictation-worker.mjs.
  const here = NodeURL.fileURLToPath(import.meta.url);
  return here.endsWith(".ts")
    ? [NodePath.join(NodePath.dirname(here), "..", "dictation-worker.ts")]
    : [NodePath.join(NodePath.dirname(here), "dictation-worker.mjs")];
}

const spawnProcess = Effect.fn("DictationWorker.spawnProcess")(function* (modelPath: string) {
  const executablePath = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const environment = yield* HostProcess.Environment;
  const child = yield* Effect.try({
    try: () =>
      NodeChildProcess.spawn(executablePath, workerArgs(isExecutable), {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        serialization: "advanced",
        // Electron hosts run the worker as plain Node.
        env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
      }),
    catch: (cause) => new DictationWorkerError({ stage: "spawn", cause }),
  });

  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });

  let nextId = 0;
  let pending:
    | { readonly id: number; readonly settle: (reply: WorkerReply | Error) => void }
    | undefined;
  let exitError: Error | undefined;
  const exitWaiters: Array<() => void> = [];
  const onExit = (error: Error) => {
    exitError ??= error;
    pending?.settle(exitError);
    pending = undefined;
    for (const waiter of exitWaiters.splice(0)) waiter();
  };
  child.on("error", (error) => onExit(error));
  child.on("exit", (code, signal) =>
    onExit(new Error(`Dictation worker exited (${signal ?? code}). ${stderrTail}`.trim())),
  );
  child.on("message", (reply: WorkerReply) => {
    if (pending?.id !== reply.id) return;
    const settle = pending.settle;
    pending = undefined;
    settle(reply);
  });

  const request = (command: WorkerCommand) =>
    Effect.callback<WorkerReply & { readonly ok: true }, DictationWorkerError>((resume) => {
      const stage = command.kind;
      if (exitError) {
        resume(Effect.fail(new DictationWorkerError({ stage: "exited", cause: exitError })));
        return;
      }
      const id = ++nextId;
      pending = {
        id,
        settle: (reply) => {
          if (reply instanceof Error) {
            resume(Effect.fail(new DictationWorkerError({ stage: "exited", cause: reply })));
          } else if (reply.ok) {
            resume(Effect.succeed(reply));
          } else {
            resume(Effect.fail(new DictationWorkerError({ stage, cause: new Error(reply.error) })));
          }
        },
      };
      child.send({ ...command, id } satisfies WorkerRequest, (error) => {
        if (error && pending?.id === id) {
          pending = undefined;
          resume(Effect.fail(new DictationWorkerError({ stage, cause: error })));
        }
      });
      return Effect.sync(() => {
        if (pending?.id === id) pending = undefined;
      });
    });

  const kill = Effect.callback<void>((resume) => {
    if (exitError || child.exitCode !== null) {
      resume(Effect.void);
      return;
    }
    exitWaiters.push(() => resume(Effect.void));
    child.kill("SIGKILL");
  }).pipe(Effect.uninterruptible);

  const loaded = yield* request({ kind: "load", path: modelPath }).pipe(Effect.onError(() => kill));
  return {
    backend: loaded.backend ?? "unknown",
    transcribe: (pcm: Int16Array) =>
      request({ kind: "transcribe", pcm }).pipe(Effect.map((reply) => reply.text ?? "")),
    kill,
  } satisfies DictationWorkerProcess;
});

export const layer = Layer.succeed(DictationWorker, DictationWorker.of({ spawn: spawnProcess }));
