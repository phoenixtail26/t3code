// Replies in the shapes real turns end with, for the spoken summary a dictated turn ends
// with. Each names what a listener must hear and what must stay unspoken.
export interface SummaryCase {
  readonly id: string;
  readonly source: string;
  readonly reply: string;
  readonly rubric: string;
  /** Every group needs one of its words in the summary, in any case. */
  readonly mustMention: ReadonlyArray<ReadonlyArray<string>>;
  /** None of these may appear. */
  readonly mustNotMention: ReadonlyArray<string>;
  /** Words in the whole summary; the prompt's forty, with a little room, when unset. */
  readonly maxWords?: number;
}

export const cases: ReadonlyArray<SummaryCase> = [
  {
    id: "build-fixed",
    source:
      "The reply apps/server/src/readAloud/real.test.ts speaks on the real engines (the on-demand read aloud's proof).",
    reply: `## Results

The build passed and all **34 tests** are green. Run them yourself with:

\`\`\`sh
pnpm test
\`\`\`

- The server route streams the PCM.
- The button stops it.

Next, try it on the phone.`,
    rubric: "The build and tests passed; try it on the phone. No command, no heading, no list.",
    mustMention: [["build", "test"], ["phone"]],
    mustNotMention: ["pnpm test", "```", "##", "PCM"],
  },
  {
    id: "needs-decision",
    source:
      "A reply that stops for a choice, in the shape of the decisions the Hearsay plan put to its owner (hearsay-run.md, phase 5).",
    reply: `I traced the flaky dictation test to the four unmerged commits on the \`dictation\` branch: they add a global stop that the test on \`main\` does not expect.

Two ways forward:

1. **Merge** the four commits, then update the test to expect the stop.
2. **Drop** the branch and keep the test as it is.

I have changed nothing yet. Which do you want?`,
    rubric:
      "The cause was found; nothing was changed; the person must choose between merging the commits and dropping the branch.",
    mustMention: [
      ["merge", "merging"],
      ["drop", "keep", "or", "either", "which", "choose", "decide", "two", "options"],
    ],
    mustNotMention: ["```", "1.", "2.", "**"],
  },
  {
    id: "long-investigation",
    source:
      "A review-fix reply with headings, a table and code, in the shape of the on-demand read aloud's first review round (report-E1.md).",
    reply: `# Stop while loading

## What was wrong

A stop while Hearsay was still loading the voice cut only the audio. The request kept running, so the server never sent \`cancel\` and the voice spoke to nobody.

## What changed

| File | Change |
| --- | --- |
| \`apps/web/src/readAloud/api.ts\` | the stop promise races the whole request |
| \`apps/server/src/readAloud/http.ts\` | the request scope closes on abort and sends cancel |

\`\`\`ts
return yield* Effect.raceFirst(exchange, Effect.promise(() => input.stop));
\`\`\`

## Checks

- 37 server tests pass, 9 web tests pass.
- Typecheck and lint are clean.

The dev instance is not restarted. Start it from the worktree and press stop while the voice loads; then check the same on the phone.`,
    rubric:
      "A stop during loading now cancels the request; tests pass; next, try a stop while the voice loads on the dev instance and the phone.",
    mustMention: [
      ["stop", "cancel"],
      ["phone", "dev instance", "try", "check"],
    ],
    mustNotMention: ["|", "```", "raceFirst", "api.ts", "http.ts"],
  },
  {
    id: "control-one-liner",
    source: "The one-word reply a turn such as 'ok, go ahead' ends with in everyday threads.",
    reply: "Done.",
    rubric: "Says it is done and nothing more. Invents no files, tests or next steps.",
    mustMention: [["done", "finished", "complete"]],
    mustNotMention: ["test", "branch", "file", "build", "next"],
    maxWords: 12,
  },
  {
    id: "control-plain-answer",
    source:
      "An explanation with no action, as a question about a repository rule gets (AGENTS.md on it.effect and the TestClock).",
    reply: `\`it.effect\` runs every test on a **TestClock**, so \`Effect.sleep\` only advances when the test calls \`TestClock.adjust\`. That is why a test that waits on real time hangs: the clock never moves on its own.

Use \`it.live\` only for a subprocess or network fixture, where wall-clock time is the point. Everywhere else, await the \`Deferred\` or drain the worker instead of sleeping.`,
    rubric:
      "Explains that tests run on a test clock that only moves when told, so sleeps hang; nothing is asked of the person.",
    mustMention: [["clock", "time"]],
    mustNotMention: ["```", "`", "**"],
    maxWords: 45,
  },
  {
    id: "error-report",
    source: "A gate that failed before any change was made, as a worker reports it in a handoff.",
    reply: `The typecheck failed before I changed anything:

\`\`\`
src/readAloud/http.ts(41,7): error TS2375: Type 'Effect<...>' is not assignable to type 'Effect<...>'.
src/readAloud/http.ts(58,3): error TS377004: This Effect requires a service that is missing from the expected Effect context: \`TextGeneration\`.
\`\`\`

\`node_modules\` is empty in this worktree, so the setup script never ran. I did not touch the code. Run \`vp i\` here and I will try again.`,
    rubric:
      "The typecheck failed, nothing was changed, and the person should install the dependencies; no error codes.",
    mustMention: [
      ["fail", "error", "did not pass", "broke"],
      ["install", "dependencies", "vp i", "setup"],
    ],
    mustNotMention: ["TS2375", "TS377004", "```", "node_modules"],
  },
];
