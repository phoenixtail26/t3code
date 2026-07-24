export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "Reveal in Finder";
  if (normalized.includes("win")) return "Reveal in File Explorer";
  return "Reveal in Files";
}

/**
 * For a directory, which is opened so the file manager shows its contents —
 * as opposed to a file, which is revealed selected inside its parent.
 */
export function openInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "Open in Finder";
  if (normalized.includes("win")) return "Open in File Explorer";
  return "Open in Files";
}
