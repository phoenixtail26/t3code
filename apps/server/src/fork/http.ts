// Fork feature: HTTP handlers for the "fork" API group (contracts/environmentHttp.ts).
// The Claude usage meter polls /api/claude/usage; clients beat /api/presence so
// PushNotifierService can skip phone pushes while the user is at the machine.
import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { recordUserPresence } from "../notifications/UserPresence.ts";
import { getClaudeUsageSummary } from "../provider/claudeUsage.ts";

export const forkHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "fork",
  Effect.fnUntraced(function* (handlers) {
    return handlers
      .handle(
        "claudeUsage",
        Effect.fn("environment.fork.claudeUsage")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* getClaudeUsageSummary("");
        }),
      )
      .handle(
        "reportPresence",
        Effect.fn("environment.fork.reportPresence")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          recordUserPresence(DateTime.toEpochMillis(yield* DateTime.now));
        }),
      );
  }),
);
