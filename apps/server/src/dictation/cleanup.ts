/**
 * Rule-based cleanup of a raw transcript: the filler pass, then the
 * dictionary pass. Both are pure so the service can keep the raw text beside
 * the cleaned text for the settings preview.
 *
 * @module dictation/cleanup
 */

export interface DictationCleanupOptions {
  readonly fillerCleanup: boolean;
  /** One `heard => wanted` entry per line. */
  readonly dictionary: string;
}

export interface DictionaryEntry {
  readonly heard: string;
  readonly wanted: string;
}

interface Token {
  lead: string;
  core: string;
  trail: string;
}

const FILLERS = /^(?:u+m+|u+h+|er|ah)$/;
// "had had" and "that that" are grammatical, so they are never collapsed.
const LEGITIMATE_DOUBLES: ReadonlySet<string> = new Set(["had", "that"]);
const SENTENCE_END = /[.?!]/;
const CLAUSE_END = /[,;:.?!]$/;

const parseToken = (word: string): Token => {
  const match = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(word);
  return { lead: match?.[1] ?? "", core: match?.[2] ?? word, trail: match?.[3] ?? "" };
};

const capitalize = (token: Token): Token => ({
  ...token,
  core: token.core.charAt(0).toUpperCase() + token.core.slice(1),
});

const startsUppercase = (core: string) => /^\p{Lu}/u.test(core);

/**
 * Drops um, uh, er, ah and "you know" used as a filler, then collapses doubled
 * words ("the the"). "you know" counts only when punctuation or the text's
 * edges set it off, so "do you know the way" is kept.
 */
export const removeFillers = (text: string): string => {
  const tokens = text.split(/\s+/).filter(Boolean).map(parseToken);
  const kept: Array<Token> = [];
  let pendingLead = "";
  let capitalizeNext = false;

  const dropFiller = (first: Token, last: Token) => {
    const previous = kept.at(-1);
    if (previous && SENTENCE_END.test(last.trail)) {
      if (!SENTENCE_END.test(previous.trail)) {
        const terminator = last.trail.replace(/[^.?!…]/g, "");
        previous.trail = previous.trail.replace(/[,;:]+$/, "") + terminator;
      }
    } else if (previous && last.trail.includes(",") && previous.trail.endsWith(",")) {
      // ", uh," reads as a parenthetical hesitation; close the gap entirely.
      previous.trail = previous.trail.slice(0, -1);
    }
    pendingLead += first.lead;
    if (startsUppercase(first.core)) capitalizeNext = true;
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const lower = token.core.toLowerCase();
    const next = tokens[index + 1];
    if (
      lower === "you" &&
      next?.core.toLowerCase() === "know" &&
      token.trail === "" &&
      next.lead === ""
    ) {
      const previous = kept.at(-1);
      const setOffBefore = !previous || CLAUSE_END.test(previous.trail) || token.lead !== "";
      const setOffAfter = index + 1 === tokens.length - 1 || CLAUSE_END.test(next.trail);
      if (setOffBefore && setOffAfter) {
        dropFiller(token, next);
        index++;
        continue;
      }
    }
    if (FILLERS.test(lower)) {
      dropFiller(token, token);
      continue;
    }
    let output: Token = { ...token, lead: pendingLead + token.lead };
    if (capitalizeNext) output = capitalize(output);
    pendingLead = "";
    capitalizeNext = false;
    kept.push(output);
  }

  const deduped: Array<Token> = [];
  for (const token of kept) {
    const previous = deduped.at(-1);
    const lower = token.core.toLowerCase();
    if (
      previous &&
      lower !== "" &&
      previous.trail === "" &&
      token.lead === "" &&
      previous.core.toLowerCase() === lower &&
      !LEGITIMATE_DOUBLES.has(lower)
    ) {
      previous.trail = token.trail;
      continue;
    }
    deduped.push(token);
  }

  return deduped.map((token) => token.lead + token.core + token.trail).join(" ");
};

/** Lines without `=>` or with an empty side are ignored. */
export const parseDictionary = (dictionary: string): Array<DictionaryEntry> =>
  dictionary.split(/\r?\n/).flatMap((line) => {
    const arrow = line.indexOf("=>");
    if (arrow === -1) return [];
    const heard = line.slice(0, arrow).trim();
    const wanted = line.slice(arrow + 2).trim();
    return heard === "" || wanted === "" ? [] : [{ heard, wanted }];
  });

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces each entry's `heard` text, case-insensitively and as whole words, in list order. */
export const applyDictionary = (text: string, entries: ReadonlyArray<DictionaryEntry>): string =>
  entries.reduce((current, entry) => {
    const heard = entry.heard.split(/\s+/).map(escapeRegExp).join("\\s+");
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${heard}(?![\\p{L}\\p{N}_])`, "giu");
    return current.replace(pattern, () => entry.wanted);
  }, text);

export const cleanTranscript = (raw: string, options: DictationCleanupOptions): string => {
  const withoutFillers = options.fillerCleanup ? removeFillers(raw) : raw;
  return applyDictionary(withoutFillers, parseDictionary(options.dictionary));
};
