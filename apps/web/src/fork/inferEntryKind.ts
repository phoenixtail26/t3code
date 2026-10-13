import { basenameOfPath } from "../pierre-icons";

/**
 * Guesses whether a path in a chat link is a file or a folder from its name
 * alone. Upstream dropped this from `pierre-icons.ts` in favour of server file
 * metadata, but a folder mention needs a verdict before any metadata exists.
 */
export function inferEntryKindFromPath(pathValue: string): "file" | "directory" {
  const base = basenameOfPath(pathValue);
  if (base.startsWith(".") && !base.slice(1).includes(".")) return "directory";
  return base.includes(".") ? "file" : "directory";
}
