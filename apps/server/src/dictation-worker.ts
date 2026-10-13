// Standalone entry for npm-distributed runtimes: the dictation service spawns
// `node dictation-worker.mjs` with an IPC channel. The executable reaches the
// same worker through the `__dictation-worker` subcommand.
import { runDictationWorker } from "./dictation/worker.ts";

await runDictationWorker();
