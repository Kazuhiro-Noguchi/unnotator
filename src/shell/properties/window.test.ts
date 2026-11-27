import { describe, expect, it } from "vitest";
import { visibleWindow } from "./window";

describe("visibleWindow", () => {
  it("見える範囲の前後に、余白（overscan）を足す", () => {
    expect(visibleWindow(280, 100, 28, 1000, 3)).toEqual({ start: 7, end: 17 });
  });

  it("先頭と末尾で、範囲を超えない", () => {
    expect(visibleWindow(0, 100, 28, 1000, 5)).toEqual({ start: 0, end: 9 });
    expect(visibleWindow(28000, 100, 28, 1000, 5)).toEqual({
      start: 995,
      end: 1000,
    });
  });

  it("行が無いとき・高さが 0 のときは、空", () => {
    expect(visibleWindow(0, 100, 28, 0, 3)).toEqual({ start: 0, end: 0 });
    expect(visibleWindow(0, 100, 0, 10, 3)).toEqual({ start: 0, end: 0 });
  });

  it("5,000 件でも、描く行は窓の分だけ", () => {
    const w = visibleWindow(70000, 600, 28, 5000, 5);
    expect(w.end - w.start).toBeLessThan(40);
  });
});
