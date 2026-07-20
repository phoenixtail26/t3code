// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expandHomePath } from "../pathExpansion.ts";

/** Mirrors the CLI's config-dir resolution used by `makeClaudeEnvironment`
 *  (see resolveClaudeCredentialsPath in ../provider/claudeUsage.ts). */
export function resolveClaudeSessionsRoot(homePath: string): string {
  const trimmed = homePath.trim();
  const configDir =
    trimmed.length > 0
      ? NodePath.resolve(expandHomePath(trimmed))
      : NodePath.join(NodeOS.homedir(), ".claude");
  return NodePath.join(configDir, "projects");
}
