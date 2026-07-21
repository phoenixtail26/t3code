import { describe, expect, it } from "vite-plus/test";

import { isNewBuildAvailable, parseBuildId } from "./newBuildAvailable.logic";

describe("parseBuildId", () => {
  it("returns a non-empty buildId string", () => {
    expect(parseBuildId({ buildId: "1700000000000" })).toBe("1700000000000");
  });

  it("ignores an empty buildId", () => {
    expect(parseBuildId({ buildId: "" })).toBeNull();
  });

  it("rejects non-string and missing buildId", () => {
    expect(parseBuildId({ buildId: 123 })).toBeNull();
    expect(parseBuildId({})).toBeNull();
  });

  it("rejects non-object payloads (e.g. an index.html SPA fallback)", () => {
    expect(parseBuildId(null)).toBeNull();
    expect(parseBuildId("<!doctype html>")).toBeNull();
    expect(parseBuildId(undefined)).toBeNull();
  });
});

describe("isNewBuildAvailable", () => {
  it("is true when the served id differs from the running id", () => {
    expect(isNewBuildAvailable("100", "200")).toBe(true);
  });

  it("is false when the ids match", () => {
    expect(isNewBuildAvailable("100", "100")).toBe(false);
  });

  it("is false when the served id is unknown", () => {
    expect(isNewBuildAvailable("100", null)).toBe(false);
  });

  it("is false when the running id is unknown (not stamped at build time)", () => {
    expect(isNewBuildAvailable("", "200")).toBe(false);
  });
});
