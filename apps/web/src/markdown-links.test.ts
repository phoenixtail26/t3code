import { describe, expect, it } from "vite-plus/test";

import {
  isInlineFileMentionCandidate,
  resolveInlineFileMentionMeta,
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";

describe("rewriteMarkdownFileUriHref", () => {
  it("rewrites file uri hrefs into direct path hrefs", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/src/main.ts#L42")).toBe(
      "/Users/julius/project/src/main.ts#L42",
    );
  });

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

  it("unwraps angle-bracketed file uri hrefs", () => {
    expect(
      rewriteMarkdownFileUriHref(" <file:///D:/Programme/t3code/apps/web/src/markdown-links.ts> "),
    ).toBe("D:/Programme/t3code/apps/web/src/markdown-links.ts");
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("formats tooltip display paths relative to the cwd when possible", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "file:///C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts#L501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath: "t3code/apps/web/src/session-logic.ts:501",
      workspaceRelativePath: "apps/web/src/session-logic.ts",
    });
  });

  it("formats tooltip display paths relative to the cwd for slash-prefixed windows paths", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath:
        "t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
      workspaceRelativePath:
        "apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
    });
  });

  it("does not create a preview path for files outside the workspace", () => {
    expect(resolveMarkdownFileLinkMeta("/tmp/report.ts", "/repo/project")).toMatchObject({
      workspaceRelativePath: null,
    });
  });

  it("normalizes slash-prefixed windows drive paths before resolving", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "/D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx:69");
  });

  it("resolves angle-bracketed windows drive paths", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "</D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1>",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1");
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
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
