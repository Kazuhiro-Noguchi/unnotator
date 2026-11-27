import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import type { LabelRow } from "../project-data/types";
import { createActiveLabel } from "./active";
import { createLabelsUi } from "./ui";

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
    t.ui.setSelected("b");
    expect(t.active.get()?.id).toBe("b");
    expect(t.context.get("activeLabelId")).toBe("b");
    t.ui.setSelected(null);
    expect(t.active.get()).toBeNull();
    expect(t.context.get("activeLabelId")).toBeNull();
  });

  it("変わったときだけ、購読者に知らせる", () => {
    const t = setup([row("a"), row("b")]);
    let calls = 0;
    t.active.subscribe(() => {
      calls += 1;
    });
    t.ui.setSelected("a");
    t.ui.setSelected("a");
    t.ui.setSelected("b");
    expect(calls).toBe(2);
  });

  it("ラベルが消えたり、非表示になったりしたら、有効ではなくなる", () => {
    const t = setup([row("a"), row("b")]);
    t.ui.setSelected("a");
    expect(t.active.get()?.id).toBe("a");
    t.setLabels([row("a", true), row("b")]);
    expect(t.active.get()).toBeNull();
    expect(t.context.get("activeLabelId")).toBeNull();
    t.setLabels([row("b")]);
    expect(t.active.get()).toBeNull();
  });

  it("ラベルの色や名前が変わったときも、最新の内容を返す", () => {
    const t = setup([row("a")]);
    t.ui.setSelected("a");
    t.setLabels([{ ...row("a"), color: "#abcdef" }]);
    expect(t.active.get()?.color).toBe("#abcdef");
  });
});
