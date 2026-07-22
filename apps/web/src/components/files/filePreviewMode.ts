export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

export interface MarkdownViewOverride {
  path: string | null;
  revealRequestId: number | null;
  rendered: boolean;
}

/**
 * Whether a markdown file preview should show the rendered ("nicely formatted")
 * view. Markdown defaults to rendered; opening at a specific line falls back to
 * source so that line is visible. An explicit per-path toggle (remembered per
 * reveal request, so a fresh line-jump re-evaluates the default) overrides both.
 */
export function resolveRenderMarkdown(params: {
  isMarkdown: boolean;
  relativePath: string | null;
  revealLine: number | null;
  revealRequestId: number | null;
  override: MarkdownViewOverride;
}): boolean {
  const { isMarkdown, relativePath, revealLine, revealRequestId, override } = params;
  if (!isMarkdown) return false;
  const overrideActive =
    override.path === relativePath &&
    (revealLine === null || override.revealRequestId === revealRequestId);
  return overrideActive ? override.rendered : revealLine === null;
}

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}
