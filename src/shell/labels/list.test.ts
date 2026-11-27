import { describe, expect, it } from "vitest";
import type { LabelRow } from "../project-data/types";
import {
  defaultLabelColor,
  dropIndexFor,
  filterLabels,
  finalIndex,
  moveLabel,
  nextSortOrder,
  reorderLabels,
} from "./list";

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

  it("並びを動かす: 位置どおりに振り直し、変わるものだけを返す。端は null", () => {
    const same = [row("a", 0), row("b", 0), row("c", 0)];
    // 全部 0 でも、b を上へ: b, a, c → 0, 1, 2（b は 0 のままで、a と c の値が変わる）
    expect(moveLabel(same, "b", "up")).toEqual([
      { id: "a", sort_order: 1 },
      { id: "c", sort_order: 2 },
    ]);
    const ordered = [row("a", 0), row("b", 1), row("c", 2)];
    expect(moveLabel(ordered, "b", "down")).toEqual([
      { id: "c", sort_order: 1 },
      { id: "b", sort_order: 2 },
    ]);
    expect(moveLabel(ordered, "a", "up")).toBeNull();
    expect(moveLabel(ordered, "c", "down")).toBeNull();
    expect(moveLabel(ordered, "zzz", "up")).toBeNull();
  });

  it("ドラッグの落とし先: カードの中心より下にポインターがあれば、その後ろに入る", () => {
    const centers = [10, 30, 50];
    expect(dropIndexFor(centers, 0)).toBe(0);
    expect(dropIndexFor(centers, 20)).toBe(1);
    expect(dropIndexFor(centers, 40)).toBe(2);
    expect(dropIndexFor(centers, 99)).toBe(3);
    expect(dropIndexFor([], 5)).toBe(0);
  });

  it("挿入位置から、取り除いたあとの位置に直す", () => {
    // 0 番を、3 つの後ろ（挿入位置 3）へ: 取り除くと 2 番になる
    expect(finalIndex(0, 3)).toBe(2);
    // 2 番を、先頭（挿入位置 0）へ
    expect(finalIndex(2, 0)).toBe(0);
    // 自分の直前・直後への挿入は、動かない
    expect(finalIndex(1, 1)).toBe(1);
    expect(finalIndex(1, 2)).toBe(1);
  });

  it("好きな位置へ動かす: 位置どおりに振り直し、変わるものだけを返す。同じ位置なら null", () => {
    const ordered = [row("a", 0), row("b", 1), row("c", 2)];
    expect(reorderLabels(ordered, "a", 2)).toEqual([
      { id: "b", sort_order: 0 },
      { id: "c", sort_order: 1 },
      { id: "a", sort_order: 2 },
    ]);
    expect(reorderLabels(ordered, "c", 0)).toEqual([
      { id: "c", sort_order: 0 },
      { id: "a", sort_order: 1 },
      { id: "b", sort_order: 2 },
    ]);
    expect(reorderLabels(ordered, "b", 1)).toBeNull();
    expect(reorderLabels(ordered, "b", 9)).toBeNull();
    expect(reorderLabels(ordered, "zzz", 0)).toBeNull();
  });
});
