import { describe, expect, it } from "vitest";
import type { LabelRow } from "../project-data/types";
import { defaultLabelColor, filterLabels, nextSortOrder } from "./list";

const row = (name: string, sort_order = 0): LabelRow => ({
  id: name,
  name,
  name_i18n_json: "{}",
  color: "#112233",
  hotkey: null,
  sort_order,
  hidden: false,
  applies_to_json: "{}",
});

describe("ラベルの一覧", () => {
  it("名前の一部で絞り込む（大文字小文字を区別しない・順序を保つ）", () => {
    const labels = [row("Cat"), row("dog"), row("Bobcat")];
    expect(filterLabels(labels, "CAT").map((l) => l.name)).toEqual([
      "Cat",
      "Bobcat",
    ]);
    expect(filterLabels(labels, "  ")).toHaveLength(3);
    expect(filterLabels(labels, "zzz")).toEqual([]);
  });

  it("次の並び順は、末尾", () => {
    expect(nextSortOrder([])).toBe(0);
    expect(nextSortOrder([row("a", 4), row("b", 2)])).toBe(5);
  });

  it("新しいラベルの色は #RRGGBB で、続けて作ると違う色になる", () => {
    const colors = [0, 1, 2, 3].map(defaultLabelColor);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(colors).size).toBe(4);
  });
});
