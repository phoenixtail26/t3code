import * as Effect from "effect/Effect";
import { Command } from "effect/cli";

import { runDictationWorker } from "../dictation/worker.ts";

/**
 * Hosts the dictation worker inside the CLI executable, which has no Node to
 * run the sibling `dictation-worker.mjs` with. The worker serves IPC requests
 * until its parent disconnects, so the handler never completes on its own.
 */
export const dictationWorkerCommand = Command.make("__dictation-worker").pipe(
  Command.unlisted,
  Command.withHandler(() =>
    Effect.promise(() => runDictationWorker()).pipe(Effect.andThen(Effect.never)),
  ),
);
