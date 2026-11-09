// Fork feature: read aloud. Whether a message holds the words of a recent dictation made with
// Hearsay's own hotkey app, judged from a page of Hearsay's history. The message is compared
// here, on the T3 server; it never goes to Hearsay.
import * as Schema from "effect/Schema";

export const HearsayHistoryEntry = Schema.Struct({
  source: Schema.String,
  state: Schema.String,
  ended_at: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
});
export type HearsayHistoryEntry = typeof HearsayHistoryEntry.Type;
export const HearsayHistoryPage = Schema.Struct({ entries: Schema.Array(HearsayHistoryEntry) });

/** How long after a dictation ended its words still mark a message as dictated. */
const DICTATION_WINDOW_MS = 10 * 60_000;

const normalise = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
// The hotkey app pastes the cleaned text with its final mark; the person may change or
// drop that mark, or write more around the words, before sending.
const withoutEndMarks = (text: string) => text.replace(/[\s.,;:!?]+$/, "");

// Hearsay writes Python's isoformat, with six fractional digits; Date.parse wants three.
const parseTime = (iso: string) => Date.parse(iso.replace(/(\.\d{3})\d+/, "$1"));

/**
 * True when an entry is a finished dictation from the hotkey app, ended within the window,
 * whose words the message contains.
 */
export function containsDictation(
  message: string,
  entries: ReadonlyArray<HearsayHistoryEntry>,
  nowMs: number,
): boolean {
  const haystack = normalise(message);
  if (haystack === "") return false;
  return entries.some((entry) => {
    if (entry.source !== "dictate" || entry.state !== "done") return false;
    if (entry.ended_at === null || entry.text === null) return false;
    const endedAt = parseTime(entry.ended_at);
    if (Number.isNaN(endedAt) || nowMs - endedAt > DICTATION_WINDOW_MS) return false;
    const needle = withoutEndMarks(normalise(entry.text));
    return needle !== "" && haystack.includes(needle);
  });
}
