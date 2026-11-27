import { describe, expect, it } from "vitest";
import { summarize } from "./measure-explorer";

describe("summarize", () => {
  it("中央値と最大値を返す", () => {
    expect(summarize([5, 1, 3])).toEqual({ count: 3, median: 3, max: 5 });
    expect(summarize([4, 2, 8, 6])).toEqual({ count: 4, median: 5, max: 8 });
  });

  it("空なら 0", () => {
    expect(summarize([])).toEqual({ count: 0, median: 0, max: 0 });
  });
});
