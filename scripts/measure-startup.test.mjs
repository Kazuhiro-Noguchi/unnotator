import { describe, expect, it } from "vitest";
import { parseReadyMs, summarize } from "./measure-startup.mjs";

describe("measure-startup", () => {
  it("標準出力から UNNOTATOR_READY_MS を読む", () => {
    expect(parseReadyMs("log\nUNNOTATOR_READY_MS=812\n")).toBe(812);
    expect(parseReadyMs("no marker")).toBeNull();
  });

  it("中央値と最大値を出す", () => {
    expect(summarize([900, 700, 800, 1000, 600])).toEqual({
      median: 800,
      max: 1000,
      runs: 5,
    });
    expect(summarize([100, 300])).toEqual({ median: 200, max: 300, runs: 2 });
  });
});
