import { expect, it } from "vite-plus/test";

import { containsDictation, type HearsayHistoryEntry } from "./dictatedHistory.ts";

const NOW = Date.parse("2026-11-10T08:00:00.000Z");

const entry = (over: Partial<HearsayHistoryEntry> = {}): HearsayHistoryEntry => ({
  source: "dictate",
  state: "done",
  ended_at: "2026-11-10T07:59:30.123456+00:00",
  text: "Fix the build.",
  ...over,
});

const table: ReadonlyArray<
  [name: string, message: string, entries: ReadonlyArray<HearsayHistoryEntry>, dictated: boolean]
> = [
  ["the pasted words alone", "Fix the build.", [entry()], true],
  ["the words with more typed around them", "Please: Fix the build. Then push.", [entry()], true],
  ["whitespace and line breaks differ", "fix   the\nbuild. ", [entry()], true],
  ["the trailing mark was changed", "Fix the build?", [entry()], true],
  ["the trailing mark was dropped and the case changed", "fix the build", [entry()], true],
  [
    "the entry's text has no trailing mark",
    "Fix the build. Then push.",
    [entry({ text: "Fix the build" })],
    true,
  ],
  ["other words", "Run the tests.", [entry()], false],
  ["a word changed inside", "Fix a build.", [entry()], false],
  [
    "an entry older than ten minutes",
    "Fix the build.",
    [entry({ ended_at: "2026-11-10T07:49:59+00:00" })],
    false,
  ],
  [
    "an entry just inside ten minutes",
    "Fix the build.",
    [entry({ ended_at: "2026-11-10T07:50:01+00:00" })],
    true,
  ],
  [
    "an entry with another offset",
    "Fix the build.",
    [entry({ ended_at: "2026-11-10T09:59:30+02:00" })],
    true,
  ],
  ["an entry with a malformed time", "Fix the build.", [entry({ ended_at: "yesterday" })], false],
  ["a t3code entry", "Fix the build.", [entry({ source: "t3code" })], false],
  [
    "an entry still recording",
    "Fix the build.",
    [entry({ state: "recording", ended_at: null, text: null })],
    false,
  ],
  ["a cancelled entry", "Fix the build.", [entry({ state: "cancelled" })], false],
  ["an entry with no text", "Fix the build.", [entry({ text: "" })], false],
  ["an entry whose text is only a full stop", "Fix the build.", [entry({ text: "." })], false],
  ["the match after other entries", "Fix the build.", [entry({ text: "Hello." }), entry()], true],
  ["an empty message", "", [entry()], false],
  ["no entries", "Fix the build.", [], false],
];

it.each(table)("%s", (_name, message, entries, dictated) => {
  expect(containsDictation(message, entries, NOW)).toBe(dictated);
});
