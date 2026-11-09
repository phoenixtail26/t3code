import { describe, expect, it } from "vite-plus/test";

import { speakableText } from "./speakableText.ts";

const cases: ReadonlyArray<{
  readonly name: string;
  readonly markdown: string;
  readonly spoken: string;
}> = [
  { name: "plain prose is unchanged", markdown: "The build passed.", spoken: "The build passed." },
  {
    name: "a fenced code block is dropped in silence",
    markdown: "Run this:\n\n```sh\npnpm test\n```\n\nThen push.",
    spoken: "Run this:\n\nThen push.",
  },
  {
    name: "a tilde fence and a fence inside a list are dropped",
    markdown: "- Step one\n\n  ~~~\n  code\n  ~~~\n\n- Step two",
    spoken: "Step one\n\nStep two",
  },
  {
    name: "an unclosed fence drops the rest",
    markdown: "Before\n\n```\nnever closed\nstill code",
    spoken: "Before",
  },
  {
    name: "an indented code block is dropped",
    markdown: "Before\n\n    const x = 1;\n    const y = 2;\n\nAfter",
    spoken: "Before\n\nAfter",
  },
  {
    name: "an indented continuation of a list item is kept, its nested code is not",
    markdown: "1. Install it\n   with pnpm.\n\n       pnpm add x\n\n2. Run it",
    spoken: "1. Install it\nwith pnpm.\n\n2. Run it",
  },
  {
    name: "a heading keeps its words without the marks and stands alone",
    markdown: "## Results ##\nAll green.",
    spoken: "Results\n\nAll green.",
  },
  {
    name: "a setext heading drops its underline",
    markdown: "Results\n=======\n\nAll green.",
    spoken: "Results\n\nAll green.",
  },
  {
    name: "emphasis, strikethrough and inline code marks go and the words stay",
    markdown: "This is **bold**, *italic*, ~~gone~~, `code` and __strong__ with snake_case_name.",
    spoken: "This is bold, italic, gone, code and strong with snake_case_name.",
  },
  {
    name: "a link keeps its text and drops its URL",
    markdown:
      'See [the docs](https://example.com/docs "Docs") and [this one][ref].\n\n[ref]: https://example.com',
    spoken: "See the docs and this one.",
  },
  {
    name: "an image is dropped",
    markdown: "Here: ![a screenshot](shot.png) done.",
    spoken: "Here: done.",
  },
  {
    name: "a blockquote keeps its words",
    markdown: "> Quoted words\n> on two lines.",
    spoken: "Quoted words\non two lines.",
  },
  {
    name: "a bullet keeps its text with the marker dropped, each item its own sentence",
    markdown: "- first\n- second\n* third",
    spoken: "first\n\nsecond\n\nthird",
  },
  {
    name: "a numbered item keeps its number",
    markdown: "1. one\n2) two",
    spoken: "1. one\n\n2. two",
  },
  {
    name: "a task list drops the checkbox",
    markdown: "- [x] done\n- [ ] not yet",
    spoken: "done\n\nnot yet",
  },
  {
    name: "a table is read row by row with commas, without the separator row",
    markdown: "| Name | Value |\n|------|------:|\n| Alpha | 1 |\n| Beta | 2 |\n\nAfter.",
    spoken: "Name, Value\n\nAlpha, 1\n\nBeta, 2\n\nAfter.",
  },
  {
    name: "HTML tags and comments are dropped",
    markdown:
      "<details><summary>More</summary>\n\nHidden <b>bold</b> text.<!-- note -->\n\n</details>",
    spoken: "More\n\nHidden bold text.",
  },
  {
    name: "a single line break stays a line break and a blank line stays a blank line",
    markdown: "One line\nnext line.\n\n\n\nNew paragraph.",
    spoken: "One line\nnext line.\n\nNew paragraph.",
  },
  {
    name: "a thematic break, escapes and entities",
    markdown: "Above\n\n---\n\nBelow with \\*stars\\* &amp; more.",
    spoken: "Above\n\nBelow with *stars* & more.",
  },
  {
    name: "Windows line endings",
    markdown: "First\r\n\r\nSecond",
    spoken: "First\n\nSecond",
  },
  { name: "nothing but code is nothing", markdown: "```\nonly code\n```", spoken: "" },
];

describe("speakableText", () => {
  it.each(cases)("$name", ({ markdown, spoken }) => {
    expect(speakableText(markdown)).toBe(spoken);
  });
});
