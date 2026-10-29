import { describe, expect, it } from "vite-plus/test";

import {
  isInlineFileMentionCandidate,
  resolveInlineCodeFileLinkMeta,
  resolveInlineFileMentionMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";
import {
  markdownFileCopyPaths,
  markdownFileEditorTarget,
  resolveMarkdownFileHostPath,
} from "./markdownFileHostPath";

describe("rewriteMarkdownFileUriHref", () => {
  it("preserves encoded octets so file paths are decoded only once later", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
  });

  it("normalizes file uri hrefs for windows drive paths", () => {
    expect(
      rewriteMarkdownFileUriHref(
        "file:///D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69");
  });

  it("preserves file uri authorities as windows UNC paths", () => {
    expect(rewriteMarkdownFileUriHref("file://server/share/workspace-image.svg")).toBe(
      "\\\\server\\share\\workspace-image.svg",
    );
  });

  // regression: #6433 workspace images in chat markdown did not render
  it("treats a localhost file uri as a local path", () => {
    expect(rewriteMarkdownFileUriHref("file://localhost/home/me/notes.md")).toBe(
      "/home/me/notes.md",
    );
  });
});

describe("relative links inside a rendered host file", () => {
  it("anchor to the file's directory while workspace membership follows cwd", () => {
    const meta = resolveMarkdownFileLinkMeta("appendix.md", "/repo", "/tmp/report");
    expect(meta).toMatchObject({
      filePath: "/tmp/report/appendix.md",
      workspaceRelativePath: null,
    });
    const inline = resolveInlineCodeFileLinkMeta("Makefile:12", "/repo", "/tmp/report");
    expect(inline).toMatchObject({ filePath: "/tmp/report/Makefile", line: 12 });
    expect(resolveMarkdownFileLinkMeta("src/main.ts", "/repo", "/repo/docs")).toMatchObject({
      filePath: "/repo/docs/src/main.ts",
      workspaceRelativePath: "docs/src/main.ts",
    });
  });
});

describe("isInlineFileMentionCandidate", () => {
  it("accepts paths that carry a directory (forward or back slash)", () => {
    expect(isInlineFileMentionCandidate("apps/server/src/ws.ts")).toBe(true);
    expect(isInlineFileMentionCandidate("apps/server/src/ws.ts:840")).toBe(true);
    expect(isInlineFileMentionCandidate("D:/Programme/t3code/apps/web/main.tsx")).toBe(true);
    expect(isInlineFileMentionCandidate(".idea\\shelf\\knockdown_fix\\shelved.patch")).toBe(true);
  });

  it("rejects bare filenames — they cannot be located without a directory", () => {
    // Would (mis)resolve to the workspace root and render a chip that fails to
    // open; e.g. claudeUsage.ts really lives under apps/server/src/provider/.
    expect(isInlineFileMentionCandidate("claudeUsage.ts")).toBe(false);
    expect(isInlineFileMentionCandidate("README.md")).toBe(false);
    expect(isInlineFileMentionCandidate("package.json")).toBe(false);
    expect(isInlineFileMentionCandidate("ws.ts:840")).toBe(false);
  });

  it("rejects ordinary property/method access and identifiers", () => {
    expect(isInlineFileMentionCandidate("arr.map")).toBe(false);
    expect(isInlineFileMentionCandidate("console.log")).toBe(false);
    expect(isInlineFileMentionCandidate("process.env")).toBe(false);
    expect(isInlineFileMentionCandidate("useState")).toBe(false);
  });

  it("rejects multi-word or whitespace-containing spans", () => {
    expect(isInlineFileMentionCandidate("see apps/foo.ts")).toBe(false);
    expect(isInlineFileMentionCandidate("const x = 1")).toBe(false);
    expect(isInlineFileMentionCandidate("")).toBe(false);
  });
});

describe("resolveInlineFileMentionMeta", () => {
  it("resolves a candidate inline path against the cwd", () => {
    expect(resolveInlineFileMentionMeta("apps/web/src/main.tsx", "/repo/project")).toMatchObject({
      workspaceRelativePath: "apps/web/src/main.tsx",
      basename: "main.tsx",
    });
  });

  it("resolves a directory-bearing path with a line suffix", () => {
    expect(
      resolveInlineFileMentionMeta("apps/server/src/ws.ts:840", "/repo/project"),
    ).toMatchObject({
      basename: "ws.ts",
      line: 840,
    });
  });

  it("returns null for a bare filename (no directory to resolve)", () => {
    expect(resolveInlineFileMentionMeta("claudeUsage.ts", "/repo/project")).toBeNull();
    expect(resolveInlineFileMentionMeta("README.md", "/repo/project")).toBeNull();
  });

  it("returns null for non-file inline code", () => {
    expect(resolveInlineFileMentionMeta("console.log", "/repo/project")).toBeNull();
    expect(resolveInlineFileMentionMeta("useState", "/repo/project")).toBeNull();
  });

  it("names a trailing-slash directory after its last segment", () => {
    // A trailing separator previously left the basename empty, so the chip
    // rendered with no label at all.
    expect(resolveInlineFileMentionMeta("C:/Apollo/logs/138396/", "/repo/project")).toMatchObject({
      basename: "138396",
    });
    expect(resolveInlineFileMentionMeta("apps/server/src/", "/repo/project")).toMatchObject({
      basename: "src",
    });
  });

  it("does not prefix the workspace label onto an absolute windows path", () => {
    // Previously displayed as "project/C:/Apollo/logs/138396/".
    expect(resolveInlineFileMentionMeta("C:/Apollo/logs/138396/", "/repo/project")).toMatchObject({
      displayPath: "C:/Apollo/logs/138396/",
    });
  });
});

describe("resolveInlineCodeFileLinkMeta", () => {
  it("links bare filenames only when a line suffix marks them as file references", () => {
    expect(resolveInlineCodeFileLinkMeta("script.ts:10", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/script.ts:10",
      line: 10,
    });
    expect(resolveInlineCodeFileLinkMeta("AGENTS.md", "/Users/julius/project")).toBeNull();
  });

  it("does not treat arbitrary name:digits shapes as files", () => {
    expect(resolveInlineCodeFileLinkMeta("error:1", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("TODO:12", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("exit:0", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("port:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("http:80", "/Users/julius/project")).toBeNull();
  });

  it("ignores hosts, ports, and versions", () => {
    expect(resolveInlineCodeFileLinkMeta("127.0.0.1:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("localhost:3000", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.com/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("example.com:8080", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("10.0.0.1:80:1", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("localhost/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.uk/index.html", "/Users/julius/project"),
    ).toBeNull();
  });
});

describe("chat file chip paths", () => {
  const cwd = String.raw`C:\Users\alice\project`;

  it("opens and copies the indexed file for a bare filename, preserving its line and column", async () => {
    const meta = resolveMarkdownFileLinkMeta("user.ts:261:7", cwd);
    if (!meta) throw new Error("Expected a file link");
    const hostPath = await resolveMarkdownFileHostPath({
      meta,
      cwd,
      findWorkspaceMatch: async () => "src/discord/events/user.ts",
    });

    expect(markdownFileEditorTarget(meta, hostPath)).toBe(
      String.raw`C:\Users\alice\project\src\discord\events\user.ts:261:7`,
    );
    expect(markdownFileCopyPaths(meta, hostPath, cwd)).toEqual({
      fullPath: String.raw`C:\Users\alice\project\src\discord\events\user.ts:261:7`,
      relativePath: "src/discord/events/user.ts:261:7",
    });
  });
});
