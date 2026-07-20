import { describe, expect, it } from "@effect/vitest";

import { buildCwdIndex, matchCwdToProject, normalizeCwdKey } from "./cwdMatching.ts";

describe("normalizeCwdKey", () => {
  it("unifies separators", () => {
    expect(normalizeCwdKey("C:\\Dev\\proj", false)).toBe("C:/Dev/proj");
  });

  it("trims trailing separators", () => {
    expect(normalizeCwdKey("C:\\Dev\\proj\\", false)).toBe("C:/Dev/proj");
    expect(normalizeCwdKey("/home/user/proj/", false)).toBe("/home/user/proj");
  });

  it("lower-cases only when case-insensitive", () => {
    expect(normalizeCwdKey("C:\\Dev\\Proj", true)).toBe("c:/dev/proj");
    expect(normalizeCwdKey("/Home/Proj", false)).toBe("/Home/Proj");
  });
});

describe("buildCwdIndex / matchCwdToProject", () => {
  const index = buildCwdIndex(
    [
      { path: "C:\\Dev\\alpha", projectId: "project-alpha" },
      { path: "C:\\Dev\\alpha", projectId: "project-duplicate" },
      { path: "C:\\Users\\u\\.t3\\worktrees\\alpha\\alpha-abc123", projectId: "project-alpha" },
    ],
    true,
  );

  it("matches workspace roots across separator and case differences", () => {
    expect(matchCwdToProject(index, "c:/dev/ALPHA", true)).toBe("project-alpha");
    expect(matchCwdToProject(index, "C:\\Dev\\alpha\\", true)).toBe("project-alpha");
  });

  it("matches worktree paths", () => {
    expect(
      matchCwdToProject(index, "C:\\Users\\u\\.t3\\worktrees\\alpha\\alpha-abc123", true),
    ).toBe("project-alpha");
  });

  it("first entry wins on duplicate paths", () => {
    expect(matchCwdToProject(index, "C:\\Dev\\alpha", true)).toBe("project-alpha");
  });

  it("returns undefined for null cwd and unknown paths", () => {
    expect(matchCwdToProject(index, null, true)).toBeUndefined();
    expect(matchCwdToProject(index, "C:\\Dev\\other", true)).toBeUndefined();
    expect(matchCwdToProject(index, "C:\\Dev\\alpha\\nested", true)).toBeUndefined();
  });
});
