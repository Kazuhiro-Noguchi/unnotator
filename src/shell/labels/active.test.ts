import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import type { LabelRow } from "../project-data/types";
import { createActiveLabel } from "./active";
import { createLabelsUi } from "./ui";

const order = ["a", "b"];

const row = (id: string, hidden = false): LabelRow => ({
  id,
  name: id,
  name_i18n_json: "{}",
  color: "#112233",
  hotkey: null,
  sort_order: 0,
  hidden,
  applies_to_json: "{}",
});

function setup(initial: LabelRow[]) {
  let labels = initial;
  const listeners = new Set<() => void>();
  const context = new Map<string, unknown>();
  const ui = createLabelsUi();
  const active = createRoot(() =>
    createActiveLabel(
      ui,
      {
        labels: () => labels,
        subscribe: (l) => {
          listeners.add(l);
          return () => {
            listeners.delete(l);
          };
        },
      },
      { set: (key, value) => void context.set(key, value) },
    ),
  );
  return {
    ui,
    active,
    context,
    setLabels(next: LabelRow[]) {
      labels = next;
      for (const l of listeners) l();
    },
  };
}

describe("ActiveLabel（選択中のラベル = 拡張機能の labels.active()）", () => {
  it("最初は無い。選ぶと、そのラベルが有効になり、コンテキストにも入る", () => {
    const t = setup([row("a"), row("b")]);
    expect(t.active.get()).toBeNull();
    t.ui.click("b", "replace", ["a", "b"]);
    expect(t.active.get()?.id).toBe("b");
    expect(t.context.get("activeLabelId")).toBe("b");
    t.ui.clearSelection();
    expect(t.active.get()).toBeNull();
    expect(t.context.get("activeLabelId")).toBeNull();
  });

  it("変わったときだけ、購読者に知らせる（同じ有効なラベルのままなら、知らせない）", () => {
    const t = setup([row("a"), row("b")]);
    let calls = 0;
    t.active.subscribe(() => {
      calls += 1;
    });
    t.ui.click("a", "replace", order);
    t.ui.click("b", "toggle", order); // 有効なラベルは b に変わる
    t.ui.click("a", "toggle", order); // a を外す。有効なのは b のまま
    t.ui.click("b", "replace", order); // b だけ → 解除
    expect(calls).toBe(3);
  });

  it("複数選択: 選んだ順に並び、有効なラベルは最後に選んだもの", () => {
    const t = setup([row("a"), row("b"), row("c")]);
    t.ui.click("c", "replace", ["a", "b", "c"]);
    t.ui.click("a", "toggle", ["a", "b", "c"]);
    expect(t.active.selected().map((l) => l.id)).toEqual(["c", "a"]);
    expect(t.active.get()?.id).toBe("a");
  });

  it("ラベルが消えたり、非表示になったりしたら、有効ではなくなる", () => {
    const t = setup([row("a"), row("b")]);
    t.ui.click("a", "replace", ["a", "b"]);
    expect(t.active.get()?.id).toBe("a");
    t.setLabels([row("a", true), row("b")]);
    expect(t.active.get()).toBeNull();
    expect(t.context.get("activeLabelId")).toBeNull();
    t.setLabels([row("b")]);
    expect(t.active.get()).toBeNull();
  });

  it("ラベルの色や名前が変わったときも、最新の内容を返す", () => {
    const t = setup([row("a")]);
    t.ui.click("a", "replace", ["a", "b"]);
    t.setLabels([{ ...row("a"), color: "#abcdef" }]);
    expect(t.active.get()?.color).toBe("#abcdef");
  });
});
