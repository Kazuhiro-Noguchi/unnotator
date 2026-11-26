import { describe, expect, it } from "vitest";
import type { Form } from "../types";
import { FORMS, fitGroups, type GroupMeasure } from "./fit";

function group(id: string, priority: number, large: number): GroupMeasure {
  return {
    id,
    priority,
    widths: {
      large,
      small: Math.round(large * 0.75),
      icon: Math.round(large * 0.5),
      dropdown: Math.round(large * 0.25),
    },
  };
}

// 設計書の「大 → 小 → アイコンのみ → グループごとのドロップダウン」。
const GROUPS: GroupMeasure[] = [
  group("clipboard", 10, 150),
  group("edit", 20, 170),
  group("relations", 30, 190),
  group("tools", 40, 120),
  group("labels", 50, 260),
  group("navigation", 60, 140),
  group("status", 70, 160),
];

const total = (forms: Record<string, Form>, groups = GROUPS) =>
  groups.reduce((sum, g) => sum + g.widths[forms[g.id] as Form], 0);
const rank = (form: Form) => FORMS.indexOf(form);

describe("リボンの縮退 fit", () => {
  it("段階の順は 大 → 小 → アイコンのみ → ドロップダウン", () => {
    expect(FORMS).toEqual(["large", "small", "icon", "dropdown"]);
  });

  it("十分に広ければ、全部が大", () => {
    const forms = fitGroups(GROUPS, 5000);
    for (const g of GROUPS) expect(forms[g.id]).toBe("large");
  });

  it("幅 800〜2,560 の全域で、合計が収まる（全部がドロップダウンでも収まらないときを除く）", () => {
    const floor = GROUPS.reduce((s, g) => s + g.widths.dropdown, 0);
    for (let width = 800; width <= 2560; width += 10) {
      const forms = fitGroups(GROUPS, width);
      if (width >= floor)
        expect(total(forms), `${width}`).toBeLessThanOrEqual(width);
    }
  });

  it("幅を増やすと、どのグループも小さくならない（単調）", () => {
    let previous = fitGroups(GROUPS, 100);
    for (let width = 110; width <= 2560; width += 10) {
      const current = fitGroups(GROUPS, width);
      for (const g of GROUPS) {
        expect(
          rank(current[g.id] as Form),
          `${g.id}@${width}`,
        ).toBeLessThanOrEqual(rank(previous[g.id] as Form));
      }
      previous = current;
    }
  });

  it("同じ入力には、同じ出力（履歴に依存しない）", () => {
    const widths = [2000, 900, 1500, 900, 2500, 800];
    const first = widths.map((w) => fitGroups(GROUPS, w));
    const second = widths.map((w) => fitGroups(GROUPS, w));
    expect(second).toEqual(first);
    expect(fitGroups(GROUPS, 900)).toEqual(first[1]);
    expect(fitGroups(GROUPS, 900)).toEqual(first[3]);
  });

  it("priority の小さいグループから先に縮退する", () => {
    const total_ = GROUPS.reduce((s, g) => s + g.widths.large, 0);
    const forms = fitGroups(GROUPS, total_ - 1);
    expect(forms.clipboard).toBe("small");
    for (const g of GROUPS.filter((x) => x.id !== "clipboard"))
      expect(forms[g.id]).toBe("large");
  });

  it("priority が同じなら、右のグループから縮退する", () => {
    const tied = [group("a", 5, 100), group("b", 5, 100), group("c", 5, 100)];
    const forms = fitGroups(tied, 299);
    expect(forms.c).toBe("small");
    expect(forms.a).toBe("large");
    expect(forms.b).toBe("large");
  });

  it("全グループがドロップダウンでも収まらないときは、全部ドロップダウン", () => {
    const forms = fitGroups(GROUPS, 10);
    for (const g of GROUPS) expect(forms[g.id]).toBe("dropdown");
  });

  it("グループが無ければ空", () => {
    expect(fitGroups([], 100)).toEqual({});
  });
});
