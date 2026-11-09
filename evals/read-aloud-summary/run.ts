import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { buildReadAloudSummaryPrompt } from "../../apps/server/src/readAloud/summaryPrompt.ts";
import { READ_ALOUD_SUMMARY_MODEL } from "../../apps/server/src/readAloud/summaryModel.ts";
import { makeClaudeTextGeneration } from "../../apps/server/src/textGeneration/ClaudeTextGeneration.ts";
import { cases } from "./cases.ts";
import { caseFails, gradeSummary, words } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: READ_ALOUD_SUMMARY_MODEL },
    baseline: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
  },
});
const { out, model } = values;
const samples = Number(values.samples);
const fixtures = cases.filter((fixture) => !values.case || fixture.id === values.case);
if (!out || !model || !fixtures.length || !Number.isSafeInteger(samples) || samples < 1) {
  throw new Error(
    "Use --out <directory> [--model <claude model>] [--case <id>] [--samples <count>].",
  );
}

const Row = Schema.Struct({
  id: Schema.String,
  sample: Schema.Number,
  text: Schema.String,
  ok: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
  latencyMs: Schema.Number,
});
const Results = Schema.fromJsonString(Schema.Array(Row));
const decodeSettings = Schema.decodeEffect(ClaudeSettings);
const decodeResults = Schema.decodeEffect(Results);
const encodeRows = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // The CLI runs in a working directory; the summary must read no checkout.
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-read-aloud-eval-" });
    const service = yield* makeClaudeTextGeneration(yield* decodeSettings({}));
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeResults))
      : null;
    const rows: Array<typeof Row.Type> = [];
    let promptChars = 0;
    let outputChars = 0;
    for (const fixture of fixtures) {
      const prompt = buildReadAloudSummaryPrompt(fixture.reply);
      for (let sample = 1; sample <= samples; sample++) {
        const [elapsed, generated] = yield* service
          .generateTranscriptionPostProcessing({
            cwd,
            prompt,
            modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model },
          })
          .pipe(Effect.timed);
        const text = generated.transcription.trim();
        promptChars += prompt.length;
        outputChars += text.length;
        const verdict = gradeSummary(text, fixture);
        rows.push({
          id: fixture.id,
          sample,
          text,
          ok: verdict.ok,
          reasons: verdict.reasons,
          latencyMs: Math.round(Duration.toMillis(elapsed)),
        });
        yield* Effect.log(
          `${fixture.id} ${sample}/${samples} ${verdict.ok ? "ok" : "FAIL"}: ${text}`,
        );
      }
    }

    const lines = [
      `# Read aloud summary: ${model}, ${fixtures.length} cases × ${samples} samples`,
      "",
      "| Case | Passed | Verdict | Baseline | Mean ms | Reasons |",
      "| --- | --- | --- | --- | --- | --- |",
    ];
    let failingCases = 0;
    for (const fixture of fixtures) {
      const mine = rows.filter((row) => row.id === fixture.id);
      const failures = mine.filter((row) => !row.ok).length;
      const fails = caseFails(failures, mine.length);
      if (fails) failingCases += 1;
      const before = baseline?.filter((row) => row.id === fixture.id) ?? [];
      const beforeText =
        baseline === null
          ? "none"
          : before.length === 0
            ? "missing"
            : `${before.filter((row) => row.ok).length}/${before.length}`;
      const mean = Math.round(mine.reduce((sum, row) => sum + row.latencyMs, 0) / mine.length);
      const reasons = Array.from(new Set(mine.flatMap((row) => row.reasons))).join("; ") || "—";
      lines.push(
        `| ${fixture.id} | ${mine.length - failures}/${mine.length} | ${fails ? "FAIL" : "pass"} | ${beforeText} | ${mean} | ${reasons} |`,
      );
    }
    const calls = rows.length;
    const meanWords = Math.round(
      rows.reduce((sum, row) => sum + words(row.text).length, 0) / calls,
    );
    lines.push(
      "",
      `${failingCases === 0 ? "All cases pass" : `${failingCases} case(s) fail`}; a case fails when half or more of its samples fail.`,
      "",
      `Cost: ${calls} calls to ${model} through \`claude -p\` on the local Claude login (the subscription, no per-call bill); about ${Math.round(promptChars / 4)} input tokens and ${Math.round(outputChars / 4)} output tokens in all, ${meanWords} words a summary on average.`,
      "",
      "Read results.json for each summary with its latency and the grader's reasons.",
    );
    yield* fs.makeDirectory(out, { recursive: true });
    yield* fs.writeFileString(path.join(out, "results.json"), yield* encodeRows(rows));
    yield* fs.writeFileString(path.join(out, "summary.md"), lines.join("\n") + "\n");
    yield* Effect.log(lines.join("\n"));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
