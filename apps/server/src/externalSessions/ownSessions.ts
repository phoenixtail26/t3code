/**
 * Collects the Claude session UUIDs that t3code itself is driving, so the
 * external-sessions radar can exclude its own threads (DESIGN.md,
 * "Own-session filter").
 *
 * Two sources, unioned:
 * - persisted runtime bindings for every known thread
 *   (`ProviderSessionDirectory.listThreadIds` + `getBinding`), covering
 *   inactive threads;
 * - live in-memory sessions across all adapters
 *   (`ProviderService.listSessions`), covering cursors allocated but not
 *   yet persisted.
 *
 * `ProviderSessionDirectory` is used rather than the lower-level
 * `ProviderSessionRuntimeRepository` because the directory is the service
 * that is ambient in the server runtime stack (`server.ts`,
 * `ProviderSessionDirectoryLayerLive`); the raw repository is internal to
 * it and not provided at the level the WS layer runs.
 *
 * Cursor JSON is provider-specific and treated as untrusted: only a string
 * `resume` field (the Claude session UUID, `ClaudeResumeState`) is read;
 * other providers' cursor shapes simply contribute nothing.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

function addResumeSessionId(ids: Set<string>, resumeCursor: unknown): void {
  if (resumeCursor === null || resumeCursor === undefined || typeof resumeCursor !== "object") {
    return;
  }
  const resume = (resumeCursor as Record<string, unknown>).resume;
  if (typeof resume === "string" && resume.length > 0) ids.add(resume);
}

export const collectOwnSessionIds = Effect.fn("collectOwnSessionIds")(
  function* (): Effect.fn.Return<
    ReadonlySet<string>,
    never,
    ProviderSessionDirectory.ProviderSessionDirectory | ProviderService
  > {
    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    const providerService = yield* ProviderService;
    const ids = new Set<string>();

    const threadIds = yield* directory
      .listThreadIds()
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<never>));
    const bindings = yield* Effect.forEach(
      threadIds,
      (threadId) =>
        directory
          .getBinding(threadId)
          .pipe(
            Effect.orElseSucceed(() =>
              Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
            ),
          ),
      { concurrency: 8 },
    );
    for (const bindingOption of bindings) {
      const binding = Option.getOrUndefined(bindingOption);
      if (binding) addResumeSessionId(ids, binding.resumeCursor);
    }

    const live = yield* providerService.listSessions();
    for (const session of live) {
      addResumeSessionId(ids, session.resumeCursor);
    }

    return ids;
  },
);
