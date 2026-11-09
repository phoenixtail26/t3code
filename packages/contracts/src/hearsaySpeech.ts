import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedString } from "./baseSchemas.ts";

/**
 * Fork feature: upstream's voice input forwards to a Hearsay speech service
 * while `url` is set; empty keeps the bundled engine. `token` is Hearsay's
 * config token, needed whenever Hearsay's config sets one.
 */
export const HearsaySpeechSettings = Schema.Struct({
  url: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  token: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});

export const HearsaySpeechSettingsPatch = Schema.Struct({
  url: Schema.optionalKey(TrimmedString),
  token: Schema.optionalKey(TrimmedString),
});
