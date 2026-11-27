import { describe, expect, it } from "vitest";
import { affectedNames, assess } from "./impact";

const s = (properties: object, required: string[] = []) =>
  JSON.stringify({ type: "object", properties, required });

describe("affectedNames（スキーマを変えると、既存の値に影響する属性の名前）", () => {
  const before = s({
    a: { type: "string" },
    b: { type: "integer" },
    c: { enum: ["x", "y"] },
    d: { type: "string", title: "D" },
  });

  it("消した属性・型を変えた属性・選択肢を減らした属性が、影響する", () => {
    const after = s({
      b: { type: "number" },
      c: { enum: ["x"] },
      d: { type: "string", title: "新しい題" },
    });
    expect(affectedNames(before, after).sort()).toEqual(["a", "b", "c"]);
  });

  it("追加・タイトルや説明・必須・既定値だけの変更は、影響しない", () => {
    const after = s(
      {
        a: { type: "string", description: "説明", default: "z" },
        b: { type: "integer" },
        c: { enum: ["x", "y", "z"] },
        d: { type: "string" },
        e: { type: "string" },
      },
      ["a"],
    );
    expect(affectedNames(before, after)).toEqual([]);
  });

  it("スキーマの削除（after が null）は、すべての属性が影響する", () => {
    expect(affectedNames(before, null).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("新規（before が null）や壊れた JSON は、影響なし", () => {
    expect(affectedNames(null, before)).toEqual([]);
    expect(affectedNames("{", before)).toEqual([]);
  });
});

describe("assess（件数から、確認が要るかを決める）", () => {
  it("0 件なら、そのまま進める。1 件以上なら、件数を示して確認する", () => {
    expect(assess(0)).toEqual({ kind: "proceed" });
    expect(assess(3)).toEqual({ kind: "confirm", count: 3 });
  });
});
