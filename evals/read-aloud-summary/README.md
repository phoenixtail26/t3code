# Read aloud summary

Checks the prompt that turns a finished reply into the few spoken sentences T3 Code reads out at the end of a dictated turn (`apps/server/src/readAloud/summaryPrompt.ts`, imported from source). Each case is a reply in a real shape: a fixed build, a stop for a decision, a long investigation with a table and code, a gate failure, and two controls (a one-word reply, an explanation with nothing to do). The grader is plain logic: no Markdown or code marks, one to three sentences, a first sentence under ten words, a word ceiling, the words a listener must hear and the ones that must stay unspoken.

## Run

Needs a `claude` login, as the server does; it runs `claude -p` with Haiku, the model the server pins. From `evals/`:

```sh
pnpm read-aloud-summary --out runs/summary
pnpm read-aloud-summary --out runs/summary-new --baseline runs/summary/results.json
```

- `--model <id>` picks another Claude model; `--case <id> --samples 1` is a smoke run.
- By default the six cases run three times each: 18 short calls, about 2 to 8 s each, on the subscription. `summary.md` records the count and the approximate tokens.
- A run writes `results.json` (each summary, its grade and latency) and `summary.md` (per case: passed samples, verdict, the baseline's count, mean latency, the reasons). A case fails when half or more of its samples fail; compare with a baseline on the same model, not with an absolute score.

## Add a case

Add an entry to `cases.ts` with an `id`, a `source`, the `reply` as the assistant wrote it, a `rubric`, `mustMention` groups (any word of a group satisfies it), `mustNotMention` words, and `maxWords` when the reply deserves fewer than the default. Add it before changing the prompt: it must fail on the old text and pass on the new.
