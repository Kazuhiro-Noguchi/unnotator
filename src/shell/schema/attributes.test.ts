import { describe, expect, it } from "vitest";
import { parseAttributes, withValue } from "./attributes";

describe("属性値の JSON", () => {
  it("オブジェクト以外・壊れた JSON は、空として読む", () => {
    expect(parseAttributes('{"a":1}')).toEqual({ a: 1 });
    expect(parseAttributes("[1]")).toEqual({});
    expect(parseAttributes("{")).toEqual({});
  });

  it("値を入れる・消す。ほかのキー（スキーマに無いもの）は残す", () => {
    expect(withValue({ a: 1, z: "keep" }, "a", 2)).toEqual({ a: 2, z: "keep" });
    expect(withValue({ a: 1, z: "keep" }, "a", undefined)).toEqual({
      z: "keep",
    });
    expect(withValue({}, "b", false)).toEqual({ b: false });
  });
});
