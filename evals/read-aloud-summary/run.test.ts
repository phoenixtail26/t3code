import { describe, expect, it } from "vite-plus/test";

import { caseFails, gradeSummary } from "./grade.ts";

const spec = {
  mustMention: [["build", "test"], ["phone"]],
  mustNotMention: ["pnpm test"],
} as const;

describe("gradeSummary", () => {
  it.each([
    ["plain short speech", "The build passed. Try it on the phone next.", []],
    ["a heading mark", "# Done. The build passed; try the phone.", ["markdown or code marks"]],
    [
      "inline code",
      "Run `pnpm test`; the build passed. Try the phone.",
      ["markdown or code marks", "mentions pnpm test"],
    ],
    [
      "a long first sentence",
      "The build passed and every one of the tests is green now. Try the phone.",
      ["first sentence has 12 words"],
    ],
    ["four sentences", "Built. Tests pass. Phone next. Really.", ["4 sentences"]],
    ["a missing mention", "The build passed. Nothing to do.", ["does not mention phone"]],
    ["nothing at all", "   ", ["empty"]],
  ] as const)("%s", (_name, text, reasons) => {
    const verdict = gradeSummary(text, spec);
    expect(verdict.reasons).toEqual(reasons);
    expect(verdict.ok).toBe(reasons.length === 0);
  });

  it("counts words against the case's own ceiling", () => {
    const text = "Done. Nothing more to say about it right now.";
    expect(gradeSummary(text, { ...spec, mustMention: [], maxWords: 5 }).reasons).toEqual([
      "9 words",
    ]);
    expect(gradeSummary(text, { ...spec, mustMention: [] }).ok).toBe(true);
  });
});

it("a case fails when half or more of its samples fail", () => {
  expect(caseFails(0, 3)).toBe(false);
  expect(caseFails(1, 3)).toBe(false);
  expect(caseFails(2, 3)).toBe(true);
  expect(caseFails(1, 2)).toBe(true);
  expect(caseFails(0, 0)).toBe(false);
});
