/**
 * Forward-only encoding of an absolute workspace path into the directory
 * name Claude Code uses under `<configDir>/projects/`. See DESIGN.md
 * ("Slug encoding"): every character outside `[A-Za-z0-9]` maps to `-`,
 * one-to-one, no collapsing, no trimming.
 *
 * This mapping is NOT reversible — a `-` in a slug can come from `\`, `:`,
 * `.`, `_`, `@`, or a literal `-` in the source path — so there is
 * deliberately no decode function. Project identity must come from the
 * `cwd` field inside session records, never from decoding a slug. Slugs
 * are used forward only: a known workspace root maps to an expected
 * directory name, which is then checked for existence.
 */
export function encodeProjectSlug(absolutePath: string): string {
  return absolutePath.replace(/[^A-Za-z0-9]/g, "-");
}
