import type { ThreadId } from "@t3tools/contracts";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { eventThreadId } from "../relay/AgentAwarenessRelay.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ObservedPhaseTracker,
  type PushNotification,
  resolvePushNotification,
} from "./PushNotifier.ts";

const REQUEST_TIMEOUT_MS = 10_000;

export class PushNotifier extends Context.Service<
  PushNotifier,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/notifications/PushNotifierService/PushNotifier") {}

const sendNotification = (notification: PushNotification) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(notification.topicUrl).pipe(
      HttpClientRequest.setHeader("title", notification.title),
      HttpClientRequest.setHeader("priority", notification.priority),
      HttpClientRequest.setHeader("tags", notification.tags),
      notification.clickUrl
        ? HttpClientRequest.setHeader("click", notification.clickUrl)
        : (unchanged) => unchanged,
      HttpClientRequest.bodyText(notification.body, "text/plain"),
    );
    const response = yield* client.execute(request).pipe(Effect.timeoutOption(REQUEST_TIMEOUT_MS));
    if (Option.isNone(response)) {
      yield* Effect.logWarning("push notification timed out");
      return;
    }
    if (response.value.status < 200 || response.value.status >= 300) {
      // Response body omitted: it can echo request content back into logs.
      yield* Effect.logWarning("push notification rejected", { status: response.value.status });
    }
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const make = Effect.gen(function* () {
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const serverSettings = yield* ServerSettingsService;
  const observedPhases = new ObservedPhaseTracker();

  const handleThread = Effect.fn("pushNotifier.handleThread")(function* (threadId: ThreadId) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.map((current) => current.pushNotifications),
      Effect.orElseSucceed(() => undefined),
    );
    // Disabled is the default; skip all projection work in that case.
    if (settings === undefined || settings.topicUrl.length === 0) return;

    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const thread = yield* snapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(thread)) {
      observedPhases.observe(threadId, null);
      return;
    }
    const project = yield* snapshotQuery.getProjectShellById(thread.value.projectId);
    if (Option.isNone(project)) return;

    const state = projectThreadAwareness({
      environmentId,
      project: project.value,
      thread: thread.value,
    });
    const notification = resolvePushNotification({
      settings,
      state,
      lastObservedPhase: observedPhases.get(threadId),
    });
    observedPhases.observe(threadId, state?.phase ?? null);
    if (notification === null) return;

    yield* Effect.logInfo("push notification sending", {
      threadId,
      phase: state?.phase ?? null,
    });
    yield* sendNotification(notification);
  });

  const start = () =>
    Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        const threadId = eventThreadId(event);
        if (threadId === null) return Effect.void;
        // Never let a notification failure disturb orchestration.
        return handleThread(threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("push notification handling failed", { threadId, cause }),
          ),
        );
      }),
    ).pipe(Effect.asVoid);

  return PushNotifier.of({ start });
});

export const layer = Layer.effect(PushNotifier, make);
