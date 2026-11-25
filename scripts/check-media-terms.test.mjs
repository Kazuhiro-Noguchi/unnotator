import { describe, expect, it } from "vitest";
import { findForbiddenTerms } from "./check-media-terms.mjs";

describe("findForbiddenTerms", () => {
  it("媒体固有の語を、行番号つきで検出する", () => {
    const hits = findForbiddenTerms(
      "a.rs",
      "fn ok() {}\nlet pixel_width = 1;\n// ズーム率\n",
    );
    expect(hits.map((h) => [h.line, h.term])).toEqual([
      [2, "pixel"],
      [3, "ズーム"],
    ]);
  });

  it("大文字小文字を区別しない", () => {
    expect(findForbiddenTerms("a.ts", "const Coordinate = 1;").length).toBe(1);
    expect(findForbiddenTerms("a.ts", "const SAMPLE_RATE = 1;").length).toBe(1);
  });

  it("記録時刻の語や、媒体に関係しない語は検出しない", () => {
    const source =
      "let created_at = 0; let updated_at = 1; // selector は不透明な値";
    expect(findForbiddenTerms("a.rs", source)).toEqual([]);
  });

  it("1 行に複数あれば、それぞれ報告する", () => {
    expect(findForbiddenTerms("a.rs", "pixel zoom").length).toBe(2);
  });
});
