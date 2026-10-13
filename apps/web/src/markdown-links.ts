import { fileBasename, workspaceRelativeFilePath } from "@t3tools/shared/path";
import {
  inlineCodeFilePathCandidate,
  isRelativeFilePath,
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkTarget,
} from "@t3tools/shared/markdownLinks";
import { parseFileUrlHref, splitFilePathPosition } from "@t3tools/shared/fileLinks";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { isTerminalLinkActivation } from "./terminal-links";

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
}

export function shouldOpenMarkdownFileLinkInEditor(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform?: string,
): boolean {
  return isTerminalLinkActivation(event, platform);
}

export function shouldOpenMarkdownFileLinkInBrowserByDefault(path: string): boolean {
  return /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(normalizeMarkdownLinkDestination(href));
  return target ? `${target.path}${target.hash}` : null;
}

/**
 * Inline code spans mostly hold identifiers, commands, and refs (`node.meta`,
 * `origin/main`) rather than deliberate link destinations, so auto-linking
 * them demands stronger path evidence than an explicit markdown link does:
 * an unambiguous path prefix, a file extension, or a :line suffix.
 */
export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const candidate = inlineCodeFilePathCandidate(codeText);
  if (candidate === null) return null;

  return resolveMarkdownFileLinkMeta(
    candidate,
    cwd,
    inlineCodePathNamesFromWorkspaceRoot(candidate, cwd, baseDir) ? cwd : baseDir,
  );
}

/**
 * Prose in a workspace file names other files from the repo root (`docs/ai/design.md`),
 * unlike an explicit link. Single-segment names (`design.md:12`) and `./`, `../`
 * paths still read as siblings, and files outside the workspace keep their own base.
 */
function inlineCodePathNamesFromWorkspaceRoot(
  candidate: string,
  cwd: string | undefined,
  baseDir: string | undefined,
): boolean {
  if (!cwd || !baseDir || !isRelativeFilePath(candidate)) return false;
  if (/^(?:~|\.{1,2})\//.test(candidate)) return false;
  if (!splitFilePathPosition(candidate).path.includes("/")) return false;
  return workspaceRelativeFilePath(baseDir, cwd) !== null;
}

/**
 * Whether an inline code span's text should be treated as a candidate file
 * mention. Requires a path separator (`/` or `\`): only a mention that carries
 * its directory can be resolved correctly against the workspace. A bare
 * filename has nowhere to resolve but the workspace root, where it almost never
 * exists (e.g. `claudeUsage.ts` really lives under `apps/server/src/provider/`),
 * so auto-linking it would render a chip that fails to open. Bare names stay
 * plain code; an explicit markdown link is still honored via the liberal href
 * path. Requiring a separator also rejects ordinary `word.word` property access
 * for free.
 */
export function isInlineFileMentionCandidate(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false;
  return /[\\/]/.test(trimmed);
}

/**
 * Resolve an inline code span's text into file-link metadata, or null when it
 * doesn't look like a file mention. Applies {@link isInlineFileMentionCandidate}
 * as a stricter pre-filter, then reuses the shared href resolution.
 */
export function resolveInlineFileMentionMeta(
  value: string,
  cwd?: string,
  baseDir?: string,
): MarkdownFileLinkMeta | null {
  if (!isInlineFileMentionCandidate(value)) return null;
  return resolveMarkdownFileLinkMeta(value.trim(), cwd, baseDir);
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd, baseDir);
  if (!targetPath) return null;
  return buildFileLinkMetaFromTarget(targetPath, cwd);
}

function buildFileLinkMetaFromTarget(targetPath: string, cwd?: string): MarkdownFileLinkMeta {
  const { path, line, column } = splitFilePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}
