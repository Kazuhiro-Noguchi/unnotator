import { describe, expect, it } from "vitest";
import type { LabelRow } from "../project-data/types";
import { validateLabel } from "./validate";

function row(id: string, name: string, hotkey: number | null = null): LabelRow {
  return {
    id,
    name,
    name_i18n_json: "{}",
    color: "#112233",
    hotkey,
    sort_order: 0,
    hidden: false,
    applies_to_json: "{}",
  };
}

const others = [row("l1", "cat", 1), row("l2", "dog", 2)];
const ok = { name: "bird", color: "#A0b1C2", hotkey: 3 as number | null };

describe("validateLabel（ラベルの検証）", () => {
  it("正しい値は、エラーなし", () => {
    expect(validateLabel(ok, others, null)).toEqual([]);
    expect(validateLabel({ ...ok, hotkey: null }, others, null)).toEqual([]);
  });

  it("名前が空（空白だけも）", () => {
    expect(validateLabel({ ...ok, name: "  " }, others, null)).toEqual([
      { field: "name", code: "nameEmpty" },
    ]);
  });

  it("名前の重複（前後の空白は無視）。自分自身は重複ではない", () => {
    expect(validateLabel({ ...ok, name: " cat " }, others, null)).toEqual([
      { field: "name", code: "nameDuplicate" },
    ]);
    expect(validateLabel({ ...ok, name: "cat" }, others, "l1")).toEqual([]);
  });

  it("色は #RRGGBB だけ", () => {
    for (const color of ["red", "#fff", "#12345", "#1234567", "112233", ""]) {
      expect(validateLabel({ ...ok, color }, others, null)).toEqual([
        { field: "color", code: "color" },
      ]);
    }
  });

  it("数字キーは 1〜9 の整数", () => {
    for (const hotkey of [0, 10, -1, 1.5]) {
      expect(validateLabel({ ...ok, hotkey }, others, null)).toEqual([
        { field: "hotkey", code: "hotkeyRange" },
      ]);
    }
  });

  it("数字キーの重複は、使っているラベルを示す。自分自身は重複ではない", () => {
    expect(validateLabel({ ...ok, hotkey: 2 }, others, null)).toEqual([
      { field: "hotkey", code: "hotkeyTaken", key: 2, name: "dog" },
    ]);
    expect(validateLabel({ ...ok, hotkey: 2 }, others, "l2")).toEqual([]);
  });

  it("複数の誤りは、すべて返す", () => {
    const errors = validateLabel(
      { name: "", color: "x", hotkey: 99 },
      others,
      null,
    );
    expect(errors.map((e) => e.field)).toEqual(["name", "color", "hotkey"]);
  });
});
