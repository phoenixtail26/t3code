import { describe, expect, it } from "@effect/vitest";

import { encodeProjectSlug } from "./projectSlug.ts";

describe("encodeProjectSlug", () => {
  // Confirmed real pairs from DESIGN.md ("Slug encoding" section) — kept
  // verbatim. Only two pairs are documented there (the task brief that
  // requested four assumed a count not actually present in DESIGN.md; see
  // the completion report for this discrepancy).
  it("encodes D:\\Dev\\x", () => {
    expect(encodeProjectSlug("D:\\Dev\\x")).toBe("D--Dev-x");
  });

  it("encodes C:\\Users\\u\\.t3", () => {
    expect(encodeProjectSlug("C:\\Users\\u\\.t3")).toBe("C--Users-u--t3");
  });

  it("maps every character outside [A-Za-z0-9] one-to-one, without collapsing runs", () => {
    expect(encodeProjectSlug("a--b")).toBe("a--b");
    expect(encodeProjectSlug("a___b")).toBe("a---b");
  });

  it("leaves an already-alphanumeric string unchanged", () => {
    expect(encodeProjectSlug("abc123XYZ")).toBe("abc123XYZ");
  });

  it("does not trim leading or trailing special characters", () => {
    expect(encodeProjectSlug("/abc/")).toBe("-abc-");
  });

  it("encodes an empty string to an empty string", () => {
    expect(encodeProjectSlug("")).toBe("");
  });
});
