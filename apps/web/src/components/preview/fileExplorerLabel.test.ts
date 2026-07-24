import { describe, expect, it } from "vite-plus/test";

import { openInFileExplorerLabel, revealInFileExplorerLabel } from "./fileExplorerLabel";

describe("revealInFileExplorerLabel", () => {
  it.each([
    ["MacIntel", "Reveal in Finder"],
    ["Win32", "Reveal in File Explorer"],
    ["Linux x86_64", "Reveal in Files"],
  ])("maps %s to %s", (platform, expected) => {
    expect(revealInFileExplorerLabel(platform)).toBe(expected);
  });
});

describe("openInFileExplorerLabel", () => {
  it.each([
    ["MacIntel", "Open in Finder"],
    ["Win32", "Open in File Explorer"],
    ["Linux x86_64", "Open in Files"],
  ])("maps %s to %s", (platform, expected) => {
    expect(openInFileExplorerLabel(platform)).toBe(expected);
  });
});
