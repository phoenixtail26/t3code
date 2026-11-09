// Fork feature: read aloud. The summary prompt is model-facing text: change it with
// evals/read-aloud-summary, which imports it from here.

// Haiku reads the whole reply at this length; a longer one keeps its opening and its ending,
// where a reply says what was done and what comes next.
const HEAD_CHARS = 6000;
const TAIL_CHARS = 2000;

export const READ_ALOUD_SUMMARY_INSTRUCTIONS = `An assistant finished a turn of work for a person who cannot see the screen. Tell them, out loud, what you would call across the room: what was done, and what they should do next. Nothing else.

Rules:
- Plain spoken English only. No Markdown, no headings, no bullets, no code, no backticks, no file paths, no URLs, no quotation of the reply. Name things in words, as a person would say them.
- Short. Thirty-five words at most, in one to three sentences; fewer is better. A reply of a word or two gets a summary of a word or two.
- The first sentence has at most eight words and gives the outcome with its subject: what passed, what was fixed, what was found, what failed, or that the assistant is waiting on them. Say what, never how or why. Keep the cause and the details out of it.
- If the reply asks for something (a decision, a check, a thing to run or look at), one short sentence says what. If it offers choices, say "you choose between" and name each choice in a few words.
- If the reply answers a question instead of doing work, give the answer itself in one or two plain sentences.
- If nothing is asked of them, stop there.
- Do not repeat the reply's reasoning, numbers or steps. Do not invent work, do not add advice of your own, and do not describe how the reply is written or that the assistant wrote it.

Put the spoken summary in the "transcription" field.`;

/** The whole prompt the summary model sees. */
export function buildReadAloudSummaryPrompt(reply: string): string {
  const text = reply.trim();
  const shown =
    text.length <= HEAD_CHARS + TAIL_CHARS
      ? text
      : `${text.slice(0, HEAD_CHARS)}\n\n[... the middle of the reply is left out ...]\n\n${text.slice(-TAIL_CHARS)}`;
  return `${READ_ALOUD_SUMMARY_INSTRUCTIONS}

<reply>
${shown}
</reply>`;
}
