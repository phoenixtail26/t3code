import { describe, expect, it } from "vite-plus/test";

import {
  formatFileCommentRange,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import {
  isMarkdownPreviewFile,
  resolveRenderMarkdown,
  setMarkdownTaskChecked,
} from "./filePreviewMode";

const NO_OVERRIDE = { path: null, revealRequestId: null, rendered: false };

describe("file comment annotations", () => {
  it("normalizes and formats selected line ranges", () => {
    expect(normalizeFileCommentRange({ start: 16, end: 7 })).toEqual({
      startLine: 7,
      endLine: 16,
    });
    expect(formatFileCommentRange(7, 7)).toBe("L7");
    expect(formatFileCommentRange(7, 16)).toBe("L7 to L16");
  });

  it("keeps an annotation range attached when Pierre remaps its anchor line", () => {
    expect(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: "comment-1",
                kind: "comment",
                startLine: 7,
                endLine: 16,
                text: "Keep this guarded.",
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        lineNumber: 20,
        metadata: {
          entries: [
            {
              id: "comment-1",
              kind: "comment",
              startLine: 11,
              endLine: 20,
              text: "Keep this guarded.",
            },
          ],
        },
      },
    ]);
  });
});

describe("isMarkdownPreviewFile", () => {
  it("recognizes markdown and MDX files case-insensitively", () => {
    expect(isMarkdownPreviewFile("README.md")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.MDX")).toBe(true);
  });

  it("does not treat other text files as markdown", () => {
    expect(isMarkdownPreviewFile("docs/guide.txt")).toBe(false);
    expect(isMarkdownPreviewFile("docs/markdown.ts")).toBe(false);
  });
});

describe("resolveRenderMarkdown", () => {
  it("defaults a markdown file with no reveal line to the rendered view", () => {
    expect(
      resolveRenderMarkdown({
        isMarkdown: true,
        relativePath: "docs/guide.md",
        revealLine: null,
        revealRequestId: null,
        override: NO_OVERRIDE,
      }),
    ).toBe(true);
  });

  it("defaults to source when opening at a specific line so the line is visible", () => {
    expect(
      resolveRenderMarkdown({
        isMarkdown: true,
        relativePath: "docs/guide.md",
        revealLine: 42,
        revealRequestId: 1,
        override: NO_OVERRIDE,
      }),
    ).toBe(false);
  });

  it("never renders a non-markdown file", () => {
    expect(
      resolveRenderMarkdown({
        isMarkdown: false,
        relativePath: "src/main.ts",
        revealLine: null,
        revealRequestId: null,
        override: NO_OVERRIDE,
      }),
    ).toBe(false);
  });

  it("honors an explicit toggle to source for the current path", () => {
    expect(
      resolveRenderMarkdown({
        isMarkdown: true,
        relativePath: "docs/guide.md",
        revealLine: null,
        revealRequestId: null,
        override: { path: "docs/guide.md", revealRequestId: null, rendered: false },
      }),
    ).toBe(false);
  });

  it("honors an explicit toggle to rendered even when a line is revealed", () => {
    expect(
      resolveRenderMarkdown({
        isMarkdown: true,
        relativePath: "docs/guide.md",
        revealLine: 42,
        revealRequestId: 7,
        override: { path: "docs/guide.md", revealRequestId: 7, rendered: true },
      }),
    ).toBe(true);
  });

  it("ignores an override recorded for a different path or stale line-jump", () => {
    // Override belongs to another file → default applies (rendered, no line).
    expect(
      resolveRenderMarkdown({
        isMarkdown: true,
        relativePath: "docs/guide.md",
        revealLine: null,
        revealRequestId: null,
        override: { path: "docs/other.md", revealRequestId: null, rendered: false },
      }),
    ).toBe(true);
    // A fresh line-jump (new revealRequestId) re-evaluates the default → source.
    expect(
      resolveRenderMarkdown({
        isMarkdown: true,
        relativePath: "docs/guide.md",
        revealLine: 99,
        revealRequestId: 2,
        override: { path: "docs/guide.md", revealRequestId: 1, rendered: true },
      }),
    ).toBe(false);
  });
});

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] First\n- [x] Second\n");
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe("- [ ] First\n- [ ] Second\n");
    expect(setMarkdownTaskChecked("1. [X] Ordered\n", 3, false)).toBe("1. [ ] Ordered\n");
  });

  it("leaves the document unchanged for a stale or invalid marker offset", () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown);
  });
});
