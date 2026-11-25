import { describe, expect, it } from "vitest";
import {
  apiVersionOf,
  checkVersion,
  missingFiles,
} from "./plugin-api-pack.mjs";

describe("plugin-api-pack", () => {
  it("index.d.ts から API_VERSION を読む", () => {
    expect(apiVersionOf("export declare const API_VERSION: '1.0.0';")).toBe(
      "1.0.0",
    );
    expect(apiVersionOf("nothing")).toBeNull();
  });

  it("版数が一致しなければ報告する", () => {
    expect(checkVersion("1.0.0", "1.0.0")).toEqual([]);
    expect(checkVersion("1.0.1", "1.0.0").join("")).toContain("1.0.1");
  });

  it("足りないファイルを報告する", () => {
    expect(
      missingFiles([
        "package/index.d.ts",
        "package/LICENSE",
        "package/README.md",
        "package/package.json",
      ]),
    ).toEqual([]);
    expect(missingFiles(["package/index.d.ts"])).toEqual([
      "LICENSE",
      "README.md",
      "package.json",
    ]);
  });
});
