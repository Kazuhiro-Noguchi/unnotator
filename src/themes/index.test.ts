import { describe, expect, it } from "vitest";
import darkCss from "./dark.css?raw";
import lightCss from "./light.css?raw";

function variableNames(css: string): string[] {
  return [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] ?? "").sort();
}

describe("themes", () => {
  it("light.css と dark.css で CSS 変数の名前の集合が一致する", () => {
    const light = variableNames(lightCss);
    const dark = variableNames(darkCss);
    expect(light.length).toBeGreaterThan(0);
    expect(dark).toEqual(light);
  });
});
