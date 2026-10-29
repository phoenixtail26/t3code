/**
 * Collects the Claude session UUIDs t3code itself drives so the radar can
 * exclude them (DESIGN.md, "Own-session filter"). Reads the projection table
 * directly: the radar needs the whole set per snapshot. The payload JSON is
 * untrusted; only a string `nativeThreadRef.nativeId` on `claudeAgent` rows is read.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const ClaudeProviderThreadRow = Schema.Struct({
  payload_json: Schema.String,
});

const ClaudeNativeThreadRef = Schema.fromJsonString(
  Schema.Struct({
    driver: Schema.String,
    nativeThreadRef: Schema.NullOr(
      Schema.Struct({
        nativeId: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);
const decodeProviderThreadPayload = Schema.decodeUnknownOption(ClaudeNativeThreadRef);

export const collectOwnSessionIds = Effect.fn("collectOwnSessionIds")(
  function* (): Effect.fn.Return<ReadonlySet<string>, never, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient;
    const ids = new Set<string>();
    const rows = yield* sql<typeof ClaudeProviderThreadRow.Type>`
      SELECT payload_json
      FROM orchestration_v2_projection_provider_threads
      WHERE driver = 'claudeAgent'
    `.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("external sessions: own-session read failed", { cause }).pipe(
          Effect.as([] as ReadonlyArray<typeof ClaudeProviderThreadRow.Type>),
        ),
      ),
    );
    for (const row of rows) {
      const payload = decodeProviderThreadPayload(row.payload_json);
      if (Option.isNone(payload) || payload.value.driver !== "claudeAgent") continue;
      const nativeId = payload.value.nativeThreadRef?.nativeId;
      if (typeof nativeId === "string" && nativeId.length > 0) ids.add(nativeId);
    }
    return ids;
  },
);
