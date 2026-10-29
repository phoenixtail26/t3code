// Fork feature (Web Push, roadmap #6): WebSocket RPC handlers for push
// registration and the test-notification button. Lives here rather than
// inline in ws.ts so the fork's contact surface in that upstream-owned file
// stays at one import and two spread lines (see AGENTS.md, "Fork additions").
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WS_METHODS,
} from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import { sendTestPushNotification } from "./PushNotifierService.ts";
import * as WebPushStore from "./WebPushStore.ts";

/** Scope entries to spread into auth/RpcAuthorization.ts's RPC_REQUIRED_SCOPES map. */
export const WEB_PUSH_RPC_SCOPES = {
  [WS_METHODS.serverSendTestPushNotification]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverWebPushStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.serverWebPushGetPublicKey]: AuthOrchestrationReadScope,
  [WS_METHODS.serverWebPushSubscribe]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverWebPushUnsubscribe]: AuthOrchestrationOperateScope,
} as const;

/** Aggregate labels to spread into observability/RpcInstrumentation.ts's RPC_AGGREGATES map. */
export const WEB_PUSH_RPC_AGGREGATES = {
  [WS_METHODS.serverSendTestPushNotification]: "server",
  [WS_METHODS.serverWebPushStatus]: "server",
  [WS_METHODS.serverWebPushGetPublicKey]: "server",
  [WS_METHODS.serverWebPushSubscribe]: "server",
  [WS_METHODS.serverWebPushUnsubscribe]: "server",
} as const;

type WebPushSubscribeInput = Parameters<WebPushStore.WebPushStore["Service"]["subscribe"]>[0];

/**
 * Builds the Web Push RPC handler entries for WsRpcGroup.of(...). Yields its
 * own service dependencies so the caller only supplies the connection-scoped
 * observe wrapper.
 */
export const makeWebPushWsHandlers = Effect.fnUntraced(function* () {
  const webPushStore = yield* WebPushStore.WebPushStore;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  return {
    [WS_METHODS.serverSendTestPushNotification]: Effect.fn(
      "notifications.wsHandlers.sendTestPushNotification",
    )(function* (_input: unknown) {
      const settings = yield* serverSettings.getSettings;
      const webPush = yield* webPushStore.snapshot.pipe(
        Effect.orElseSucceed((): WebPushStore.WebPushSnapshot => ({
          vapidKeys: Option.none(),
          subscriptions: [],
        })),
      );
      const result = yield* sendTestPushNotification(settings.pushNotifications, webPush);
      // Best-effort: a prune failure must not mask the test result.
      yield* webPushStore.prune(result.goneEndpoints).pipe(Effect.ignore);
      return { sent: result.sent, detail: result.detail };
    }),
    [WS_METHODS.serverWebPushStatus]: (_input: unknown) =>
      webPushStore.snapshot.pipe(
        Effect.map((snapshot) => ({
          subscriptionCount: snapshot.subscriptions.length,
          deviceLabels: snapshot.subscriptions.map(
            (subscription) => subscription.deviceLabel ?? "Unknown device",
          ),
        })),
      ),
    [WS_METHODS.serverWebPushGetPublicKey]: (_input: unknown) =>
      webPushStore.getPublicKey.pipe(Effect.map((publicKey) => ({ publicKey }))),
    [WS_METHODS.serverWebPushSubscribe]: (input: WebPushSubscribeInput) =>
      webPushStore.subscribe(input),
    [WS_METHODS.serverWebPushUnsubscribe]: (input: { readonly endpoint: string }) =>
      webPushStore.unsubscribe(input.endpoint),
  };
});
