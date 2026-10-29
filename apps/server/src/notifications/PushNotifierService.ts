import type { PushNotificationSettings, ThreadId } from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  COMPLETION_RECHECK_MS,
  ObservedPhaseTracker,
  type PushNotification,
  resolvePushNotification,
} from "./PushNotifier.ts";
import { isUserPresent, readLastPresenceMs } from "./UserPresence.ts";
import { sendWebPushNotifications, vapidSubjectFor } from "./WebPushSender.ts";
import * as WebPushStore from "./WebPushStore.ts";

const REQUEST_TIMEOUT_MS = 10_000;

class PushNotifier extends Context.Service<
  PushNotifier,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/notifications/PushNotifierService/PushNotifier") {}

const sendNtfyNotification = Effect.fn("PushNotifier.sendNtfyNotification")(function* (
  topicUrl: string,
  notification: PushNotification,
) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.post(topicUrl).pipe(
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
}, Effect.provide(FetchHttpClient.layer));

const sendWebPushToSnapshot = Effect.fn("PushNotifier.sendWebPushToSnapshot")(function* (input: {
  readonly settings: PushNotificationSettings;
  readonly webPush: WebPushStore.WebPushSnapshot;
  readonly notification: PushNotification;
}) {
  const vapidKeys = input.webPush.vapidKeys;
  if (Option.isNone(vapidKeys) || input.webPush.subscriptions.length === 0) {
    return [];
  }
  return yield* sendWebPushNotifications({
    vapidKeys: vapidKeys.value,
    vapidSubject: vapidSubjectFor(input.settings.publicBaseUrl),
    payload: {
      title: input.notification.title,
      body: input.notification.body,
      url: input.notification.clickUrl ?? "",
      tag: input.notification.threadTag,
    },
    subscriptions: input.webPush.subscriptions,
  });
});

/**
 * Fire a test push over every configured channel. Bypasses presence suppression;
 * failures are returned as values. `goneEndpoints` lists dead Web Push
 * subscriptions for the caller to prune (no store access here).
 */
export const sendTestPushNotification = Effect.fn("PushNotifierService.sendTestPushNotification")(
  function* (settings: PushNotificationSettings, webPush: WebPushStore.WebPushSnapshot) {
    const hasNtfy = settings.topicUrl.length > 0;
    const webPushReady = Option.isSome(webPush.vapidKeys) && webPush.subscriptions.length > 0;
    if (!hasNtfy && !webPushReady) {
      return {
        sent: false,
        detail: "No topic URL configured and no Web Push devices registered.",
        goneEndpoints: [],
      };
    }

    const parts: Array<string> = [];
    let sent = false;
    let goneEndpoints: ReadonlyArray<string> = [];

    if (hasNtfy) {
      const ntfy = yield* sendTestNtfyNotification(settings);
      sent = sent || ntfy.sent;
      parts.push(`ntfy: ${ntfy.detail}`);
    }

    if (webPushReady) {
      const results = yield* sendWebPushToSnapshot({
        settings,
        webPush,
        notification: {
          title: "Test notification",
          body: "T3 Code push is configured correctly.",
          priority: "default",
          tags: "bell",
          threadTag: "t3code-test",
          ...(settings.publicBaseUrl.length > 0 ? { clickUrl: settings.publicBaseUrl } : {}),
        },
      });
      const delivered = results.filter((result) => result.outcome === "delivered").length;
      goneEndpoints = results.filter((result) => result.gone).map((result) => result.endpoint);
      sent = sent || delivered > 0;
      const bits = [`${delivered}/${results.length} delivered`];
      if (goneEndpoints.length > 0) {
        bits.push(
          `${goneEndpoints.length} stale ${goneEndpoints.length === 1 ? "device" : "devices"} removed`,
        );
      }
      parts.push(`Web Push: ${bits.join(", ")}.`);
    }

    return { sent, detail: parts.join(" · "), goneEndpoints };
  },
);

const sendTestNtfyNotification = Effect.fn("PushNotifierService.sendTestNtfyNotification")(
  function* (settings: PushNotificationSettings) {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(settings.topicUrl).pipe(
      HttpClientRequest.setHeader("title", "Test notification"),
      HttpClientRequest.setHeader("priority", "default"),
      HttpClientRequest.setHeader("tags", "bell"),
      settings.publicBaseUrl.length > 0
        ? HttpClientRequest.setHeader("click", settings.publicBaseUrl)
        : (unchanged) => unchanged,
      HttpClientRequest.bodyText("T3 Code phone push is configured correctly.", "text/plain"),
    );
    return yield* client.execute(request).pipe(
      Effect.timeoutOption(REQUEST_TIMEOUT_MS),
      Effect.map((response) => {
        if (Option.isNone(response)) {
          return {
            sent: false,
            detail: `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
          };
        }
        const status = response.value.status;
        return status >= 200 && status < 300
          ? { sent: true, detail: `Delivered (HTTP ${status}).` }
          : { sent: false, detail: `The push server rejected the request (HTTP ${status}).` };
      }),
      Effect.orElseSucceed(() => ({
        sent: false,
        detail: "Could not reach the topic URL.",
      })),
    );
  },
  Effect.provide(FetchHttpClient.layer),
);

const make = Effect.gen(function* () {
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettingsService;
  const webPushStore = yield* WebPushStore.WebPushStore;
  const observedPhases = new ObservedPhaseTracker();

  const deliver = Effect.fn("pushNotifier.deliver")(function* (
    settings: PushNotificationSettings,
    notification: PushNotification,
  ) {
    if (settings.topicUrl.length > 0) {
      yield* sendNtfyNotification(settings.topicUrl, notification);
    }
    const webPush = yield* webPushStore.snapshot.pipe(
      Effect.orElseSucceed((): WebPushStore.WebPushSnapshot => ({
        vapidKeys: Option.none(),
        subscriptions: [],
      })),
    );
    const results = yield* sendWebPushToSnapshot({ settings, webPush, notification });
    const failed = results.filter((result) => result.outcome !== "delivered");
    if (failed.length > 0) {
      // Endpoints are capabilities; log outcomes only.
      yield* Effect.logWarning("web push delivery incomplete", {
        outcomes: failed.map(
          (result) => `${result.outcome}${result.status ? ` (${result.status})` : ""}`,
        ),
      });
    }
    const gone = results.filter((result) => result.gone).map((result) => result.endpoint);
    yield* webPushStore
      .prune(gone)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to prune dead web push subscriptions", { cause }),
        ),
      );
  });

  // Threads with a completion recheck fiber in flight, so repeated completed
  // transitions inside the window arm exactly one recheck.
  const pendingCompletionRechecks = new Set<ThreadId>();

  const deliverUnlessPresent = Effect.fn("pushNotifier.deliverUnlessPresent")(function* (
    threadId: ThreadId,
    settings: PushNotificationSettings,
    phase: string | null,
    notification: PushNotification,
  ) {
    // The user is at the machine and already got a desktop notification, so a
    // push to their pocket is pure duplication.
    if (
      isUserPresent({
        nowMs: DateTime.toEpochMillis(yield* DateTime.now),
        windowSeconds: settings.suppressWhenPresentSeconds,
        lastPresentAtMs: readLastPresenceMs(),
      })
    ) {
      yield* Effect.logDebug("push notification suppressed; user present at machine", {
        threadId,
        phase,
      });
      return;
    }

    yield* Effect.logInfo("push notification sending", { threadId, phase });
    yield* deliver(settings, notification);
  });

  // One shell read per event (the relay does the same): materializing the
  // whole shell here would make each thread's activity cost proportional to
  // how many threads exist. Subagent threads never notify.
  const readThreadState = Effect.fn("pushNotifier.readThreadState")(function* (threadId: ThreadId) {
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const thread = yield* threads.getThreadShell(threadId);
    if (thread === null || thread.archivedAt !== null) return Option.none();
    if (thread.lineage.relationshipToParent === "subagent") return Option.none();
    const project = yield* projects.getById(thread.projectId);
    if (Option.isNone(project)) return Option.none();
    return Option.some(projectThreadAwarenessV2({ environmentId, project: project.value, thread }));
  });

  // Delayed leg of a completion push: re-read the thread after the window and
  // deliver only if it is still settled. Anything else means work resumed (or
  // a blocking phase already notified through the normal transition path).
  const recheckCompletion = Effect.fn("pushNotifier.recheckCompletion")(function* (
    threadId: ThreadId,
    settings: PushNotificationSettings,
  ) {
    yield* Effect.sleep(Duration.millis(COMPLETION_RECHECK_MS));
    const current = yield* readThreadState(threadId);
    if (Option.isNone(current)) return;
    const state = current.value;
    if (state?.phase !== "completed") return;
    const notification = resolvePushNotification({
      settings,
      state,
      // The completed transition was deliberately withheld when this recheck
      // was armed; treat it as fresh here.
      lastObservedPhase: undefined,
    });
    if (notification === null) return;
    yield* deliverUnlessPresent(threadId, settings, state.phase, notification);
  });

  const handleThread = Effect.fn("pushNotifier.handleThread")(function* (threadId: ThreadId) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.map((current) => current.pushNotifications),
      Effect.orElseSucceed(() => undefined),
    );
    if (settings === undefined) return;
    const hasWebPush = yield* webPushStore.hasSubscriptions.pipe(Effect.orElseSucceed(() => false));
    // Disabled is the default; skip all projection work in that case.
    if (settings.topicUrl.length === 0 && !hasWebPush) return;

    const current = yield* readThreadState(threadId);
    if (Option.isNone(current)) {
      observedPhases.observe(threadId, null);
      return;
    }
    // projectThreadAwarenessV2 already holds a settled turn at "running" while
    // native background work (subagents, workflows) is still pending, so a
    // finish push fires only when the sidebar pill would go green.
    const state = current.value;
    const notification = resolvePushNotification({
      settings,
      state,
      lastObservedPhase: observedPhases.get(threadId),
    });
    // The phase is recorded whether or not anything is delivered, so stepping
    // away later does not replay old transitions.
    observedPhases.observe(threadId, state?.phase ?? null);
    if (notification === null) return;

    // Completions are deferred, mirroring the web client's debounce: the event
    // that carried this transition is often the last background task landing,
    // with the agent about to resume. The recheck delivers only if the thread
    // stays settled through the window.
    if (state?.phase === "completed") {
      if (pendingCompletionRechecks.has(threadId)) return;
      pendingCompletionRechecks.add(threadId);
      yield* recheckCompletion(threadId, settings).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("push completion recheck failed", { threadId, cause }),
        ),
        Effect.ensuring(Effect.sync(() => pendingCompletionRechecks.delete(threadId))),
        Effect.forkScoped,
      );
      return;
    }

    yield* deliverUnlessPresent(threadId, settings, state?.phase ?? null, notification);
  });

  const start = () =>
    Effect.forkScoped(
      Stream.runForEach(threads.streamDomainEvents, (event) => {
        // Same event filter as the relay: only events that can move the
        // awareness phase are worth a shell read.
        if (!shouldPublishAgentAwarenessEvent(event)) return Effect.void;
        const threadId = event.threadId;
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

/**
 * Self-starting: v1 started reactors from one OrchestrationReactor; v2 has no
 * such hub, so the layer forks the domain-event subscription into its own
 * scope, like `StorageCleanup` in server.ts.
 */
export const layer = Layer.effectDiscard(Effect.flatMap(make, (service) => service.start()));
