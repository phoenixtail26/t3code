import { describe, expect, it } from "@effect/vitest";

import { resolveClaudeSdkExecutablePath } from "./ClaudeSdkExecutable.ts";

function makeProbe(existingFiles: ReadonlyArray<string>) {
  const files = new Set(existingFiles.map((file) => file.toLowerCase()));
  return { isFile: (candidate: string) => files.has(candidate.toLowerCase()) };
}

describe("resolveClaudeSdkExecutablePath", () => {
  it("returns the configured value unchanged on non-Windows platforms", () => {
    expect(
      resolveClaudeSdkExecutablePath("claude", { PATH: "/usr/local/bin" }, "darwin", makeProbe([])),
    ).toBe("claude");
  });

  it("returns explicit paths unchanged on Windows", () => {
    const explicit = "C:\\tools\\claude\\claude.exe";
    expect(
      resolveClaudeSdkExecutablePath(explicit, { PATH: "C:\\other" }, "win32", makeProbe([])),
    ).toBe(explicit);
  });

  it("resolves a bare command to a native executable on PATH", () => {
    const executable = "C:\\Users\\me\\.local\\bin\\claude.exe";
    expect(
      resolveClaudeSdkExecutablePath(
        "claude",
        { PATH: "C:\\Users\\me\\.local\\bin" },
        "win32",
        makeProbe([executable]),
      ),
    ).toBe(executable);
  });

  it("resolves an npm shim to the packaged executable beside it", () => {
    const npmDir = "C:\\Users\\me\\AppData\\Roaming\\npm";
    const packaged = `${npmDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    expect(
      resolveClaudeSdkExecutablePath(
        "claude",
        { PATH: `C:\\Windows\\system32;${npmDir}` },
        "win32",
        makeProbe([`${npmDir}\\claude.ps1`, `${npmDir}\\claude.cmd`, packaged]),
      ),
    ).toBe(packaged);
  });

  it("resolves an npm shim to the packaged cli.js when no executable ships", () => {
    const npmDir = "C:\\Users\\me\\AppData\\Roaming\\npm";
    const packagedCli = `${npmDir}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    expect(
      resolveClaudeSdkExecutablePath(
        "claude",
        { PATH: npmDir },
        "win32",
        makeProbe([`${npmDir}\\claude.cmd`, packagedCli]),
      ),
    ).toBe(packagedCli);
  });

  it("keeps the bare command when nothing on PATH matches", () => {
    expect(
      resolveClaudeSdkExecutablePath(
        "claude",
        { PATH: 'C:\\Windows\\system32;  ;"C:\\quoted"' },
        "win32",
        makeProbe([]),
      ),
    ).toBe("claude");
  });
});
