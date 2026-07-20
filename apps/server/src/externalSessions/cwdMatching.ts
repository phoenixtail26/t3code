/**
 * Pure helpers matching an external session's recorded `cwd` to a t3
 * project (via project `workspaceRoot` or thread `worktreePath`). See
 * DESIGN.md, "Own-session filter".
 *
 * Junction/symlink resolution is deliberately out of scope: both sides of
 * the comparison come from the same filesystem, so plain lexical
 * normalization (separators, trailing slashes, case on Windows) is enough
 * in practice.
 */

export function normalizeCwdKey(rawPath: string, caseInsensitive: boolean): string {
  let key = rawPath.trim().replace(/\\/g, "/");
  while (key.length > 1 && key.endsWith("/")) {
    key = key.slice(0, -1);
  }
  return caseInsensitive ? key.toLowerCase() : key;
}

export interface CwdIndexEntry {
  readonly path: string;
  readonly projectId: string;
}

/** Later entries do not overwrite earlier ones, so callers should list
 * project workspace roots before thread worktrees: a worktree that equals a
 * workspace root resolves to the project mapping. */
export function buildCwdIndex(
  entries: ReadonlyArray<CwdIndexEntry>,
  caseInsensitive: boolean,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const entry of entries) {
    const key = normalizeCwdKey(entry.path, caseInsensitive);
    if (key.length === 0) continue;
    if (!index.has(key)) index.set(key, entry.projectId);
  }
  return index;
}

export function matchCwdToProject(
  index: ReadonlyMap<string, string>,
  cwd: string | null,
  caseInsensitive: boolean,
): string | undefined {
  if (cwd === null) return undefined;
  return index.get(normalizeCwdKey(cwd, caseInsensitive));
}
