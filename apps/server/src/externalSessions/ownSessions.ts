/**
 * Collects the Claude session UUIDs that t3code itself is driving, so the
 * external-sessions radar can exclude its own threads (DESIGN.md,
 * "Own-session filter").
 *
 * Orchestration v2 records every provider conversation it owns as a provider
 * thread whose `nativeThreadRef.nativeId` is the CLI's session id (for Claude,
 * the JSONL filename). One read over the projection table covers every
 * thread, live or idle, including threads adopted from the radar. The payload
 * JSON is provider-specific and treated as untrusted: only a string
 * `nativeThreadRef.nativeId` on a `claudeAgent` row is read.
 *
 * Read directly rather than through `ProjectionStore`, whose provider-thread
 * queries are scoped to one thread: the radar needs the whole set per
 * snapshot, and a per-thread fan-out would make a radar refresh cost
 * proportional to how many threads exist.
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
