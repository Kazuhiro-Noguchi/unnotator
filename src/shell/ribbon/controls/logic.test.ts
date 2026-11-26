import { describe, expect, it } from "vitest";
import type { RibbonControl } from "../../types";
import { commitNumber, galleryInvocation, primaryInvocation } from "./logic";

const range = { min: 0, max: 10, step: 1 };

describe("数値入力", () => {
  it("範囲内の数値は確定する", () => {
    expect(commitNumber("5", range, 3)).toEqual({ commit: true, value: 5 });
    expect(commitNumber(" 7 ", range, 3)).toEqual({ commit: true, value: 7 });
    expect(commitNumber("0", range, 3)).toEqual({ commit: true, value: 0 });
    expect(commitNumber("10", range, 3)).toEqual({ commit: true, value: 10 });
  });

  it("範囲外・非数値・空は、確定せず、直前の値に戻す", () => {
    for (const text of [
      "11",
      "-1",
      "abc",
      "",
      "  ",
      "NaN",
      "Infinity",
      "1e999",
    ]) {
      expect(commitNumber(text, range, 3), text).toEqual({
        commit: false,
        value: 3,
      });
    }
  });

  it("刻み（step）に丸める", () => {
    expect(commitNumber("5.4", range, 3)).toEqual({ commit: true, value: 5 });
    expect(commitNumber("5.6", range, 3)).toEqual({ commit: true, value: 6 });
    expect(commitNumber("2", { min: 1, max: 9, step: 2 }, 1)).toEqual({
      commit: true,
      value: 3,
    });
  });

  it("小数の刻みでも、誤差を出さない", () => {
    expect(commitNumber("0.3", { min: 0, max: 1, step: 0.1 }, 0)).toEqual({
      commit: true,
      value: 0.3,
    });
  });
});

describe("ギャラリーと分割ボタン", () => {
  const items: RibbonControl[] = [
    { kind: "smallButton", command: "core.a", args: 1 },
    { kind: "smallButton", command: "core.b", args: { n: 2 } },
  ];

  it("ギャラリーは、選んだ項目のコマンドと引数を返す", () => {
    const gallery: RibbonControl = { kind: "gallery", items };
    expect(galleryInvocation(gallery, 1)).toEqual({
      command: "core.b",
      args: { n: 2 },
    });
    expect(galleryInvocation(gallery, 0)).toEqual({
      command: "core.a",
      args: 1,
    });
    expect(galleryInvocation(gallery, 5)).toBeNull();
    expect(galleryInvocation(gallery, -1)).toBeNull();
  });

  it("分割ボタンの主ボタンは、自分のコマンド、無ければ最初の項目", () => {
    expect(
      primaryInvocation({ kind: "splitButton", command: "core.main", items }),
    ).toEqual({ command: "core.main" });
    expect(primaryInvocation({ kind: "splitButton", items })).toEqual({
      command: "core.a",
      args: 1,
    });
    expect(primaryInvocation({ kind: "splitButton" })).toBeNull();
  });

  it("引数が無いときは、args を含めない", () => {
    expect(
      primaryInvocation({ kind: "largeButton", command: "core.x" }),
    ).toEqual({ command: "core.x" });
  });
});
