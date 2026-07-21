import { WsRpcGroup } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { RPC_REQUIRED_SCOPE } from "./ws.ts";

// requiredScopeForMethod throws at request time for any served rpc without a
// declared scope, so a missing entry is a runtime defect the type system
// cannot catch (this bit the server.sendTestPushNotification rpc).
it("declares an authorization scope for every rpc served over the WebSocket", () => {
  const missing = [...WsRpcGroup.requests.keys()].filter((tag) => !RPC_REQUIRED_SCOPE.has(tag));
  assert.deepStrictEqual(missing, []);
});
