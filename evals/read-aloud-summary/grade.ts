import type { SummaryCase } from "./cases.ts";

export interface Verdict {
  readonly ok: boolean;
  readonly reasons: ReadonlyArray<string>;
}

const DEFAULT_MAX_WORDS = 45;
const MAX_SENTENCES = 3;
const MAX_FIRST_SENTENCE_WORDS = 9;
// Any of these on the page is Markdown or code a voice would read as noise.
const MARKS = /[#*`_~>|]|\[[^\]]*\]\(|https?:\/\/|^\s*[-+]\s/m;

export function words(text: string): ReadonlyArray<string> {
  return text.split(/\s+/).filter((word) => word.length > 0);
}

export function sentences(text: string): ReadonlyArray<string> {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Whether the summary is short plain speech that says what the case needs said. */
export function gradeSummary(
  text: string,
  spec: Pick<SummaryCase, "mustMention" | "mustNotMention" | "maxWords">,
): Verdict {
  const reasons: string[] = [];
  const summary = text.trim();
  if (summary.length === 0) return { ok: false, reasons: ["empty"] };
  if (MARKS.test(summary)) reasons.push("markdown or code marks");
  const parts = sentences(summary);
  if (parts.length > MAX_SENTENCES) reasons.push(`${parts.length} sentences`);
  const first = words(parts[0] ?? "").length;
  if (first > MAX_FIRST_SENTENCE_WORDS) reasons.push(`first sentence has ${first} words`);
  const total = words(summary).length;
  const maxWords = spec.maxWords ?? DEFAULT_MAX_WORDS;
  if (total > maxWords) reasons.push(`${total} words`);
  const lower = summary.toLowerCase();
  for (const group of spec.mustMention) {
    if (!group.some((word) => lower.includes(word.toLowerCase())))
      reasons.push(`does not mention ${group.join(" or ")}`);
  }
  for (const word of spec.mustNotMention) {
    if (lower.includes(word.toLowerCase())) reasons.push(`mentions ${word}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** A case fails when half or more of its samples fail. */
export function caseFails(failures: number, samples: number): boolean {
  return samples > 0 && failures * 2 >= samples;
}
