import { describe, expect, it } from "vitest";
import { versionSatisfies } from "./semver";

describe("versionSatisfies（Rust の version_satisfies と同じ規則）", () => {
  it.each([
    ["*", "9.9.9", true],
    ["1.2.3", "1.2.3", true],
    ["1.2.3", "1.2.4", false],
    [">=1.2.0", "1.3.0", true],
    [">=1.2.0", "1.1.9", false],
    ["^1.2.0", "1.9.0", true],
    ["^1.2.0", "2.0.0", false],
    ["^0.2.0", "0.2.9", true],
    ["^0.2.0", "0.3.0", false],
    ["^0.0.1", "0.0.1", true],
    ["^0.0.1", "0.0.2", false],
    ["~1.2.0", "1.2.9", true],
    ["~1.2.0", "1.3.0", false],
    ["^1", "1.9.9", true],
  ])("%s と %s → %s", (range, version, expected) => {
    expect(versionSatisfies(range, version)).toBe(expected);
  });
  it("読めない範囲・版は false", () => {
    expect(versionSatisfies("garbage", "1.0.0")).toBe(false);
    expect(versionSatisfies("^1.0.0", "garbage")).toBe(false);
  });
});
