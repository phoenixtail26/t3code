/**
 * Forward-only encoding of an absolute workspace path into Claude Code's
 * `<configDir>/projects/` directory name (DESIGN.md "Slug encoding"): every
 * character outside `[A-Za-z0-9]` maps to `-`. Not reversible, so there is no
 * decode; project identity comes from the `cwd` inside session records.
 */
export function encodeProjectSlug(absolutePath: string): string {
  return absolutePath.replace(/[^A-Za-z0-9]/g, "-");
}
