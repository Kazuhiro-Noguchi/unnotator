import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import type {
  AnnotationRow,
  LabelRow,
  TargetDetails,
} from "../project-data/types";
import { createActiveLabels } from "./active";

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

const classification = (labelId: string | null): AnnotationRow => ({
  id: `c-${labelId}`,
  type: "core/classification",
  type_version: 1,
  label_id: labelId,
  attributes_json: "{}",
  summary: "",
  z_order: 0,
  source: "manual",
});

function detailsOf(labelIds: Array<string | null>): TargetDetails {
  return {
    asset: {
      id: "a1",
      root_key: "",
      rel_path: "a.bin",
      media_type: null,
      missing: false,
      status: "todo",
      note: null,
      attributes_json: "{}",
    },
    item: null,
    classification: labelIds.map(classification),
    annotation_count: labelIds.length,
    relations: [],
    groups: [],
  };
}

function setup(labels: LabelRow[], details: TargetDetails | null) {
  let current = { labels, details };
  const listeners = new Set<() => void>();
  const context = new Map<string, unknown>();
  const active = createRoot(() =>
    createActiveLabels(
      {
        labels: () => current.labels,
        details: () => current.details,
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
    active,
    context,
    update(next: Partial<typeof current>) {
      current = { ...current, ...next };
      for (const l of listeners) l();
    },
  };
}

describe("ActiveLabels（選択中のラベル = 現在位置に付いている分類）", () => {
  it("未分類なら、何も選択されていない。コンテキストも空", () => {
    const t = setup([row("a")], detailsOf([]));
    expect([...t.active.ids()]).toEqual([]);
    expect(t.active.get()).toBeNull();
    expect(t.context.get("activeLabelId")).toBeNull();
  });

  it("分類済みなら、そのラベルが選択される（複数もそのまま）", () => {
    const t = setup([row("a"), row("b")], detailsOf(["b", "a"]));
    expect([...t.active.ids()].sort()).toEqual(["a", "b"]);
    // 有効なラベルは、先頭の 1 つ
    expect(t.active.get()?.id).toBe("b");
    expect(t.context.get("activeLabelId")).toBe("b");
  });

  it("別のアセットへ移ると（詳細が変わると）、選択も追従する", () => {
    const t = setup([row("a"), row("b")], detailsOf(["a"]));
    expect(t.active.get()?.id).toBe("a");
    t.update({ details: detailsOf([]) });
    expect(t.active.get()).toBeNull();
    t.update({ details: detailsOf(["b"]) });
    expect(t.active.get()?.id).toBe("b");
    t.update({ details: null });
    expect([...t.active.ids()]).toEqual([]);
  });

  it("変わったときだけ、購読者に知らせる", () => {
    const t = setup([row("a"), row("b")], detailsOf([]));
    let calls = 0;
    t.active.subscribe(() => {
      calls += 1;
    });
    t.update({ details: detailsOf(["a"]) });
    t.update({ details: detailsOf(["a"]) });
    t.update({ details: detailsOf(["b"]) });
    expect(calls).toBe(2);
  });

  it("非表示のラベルは、選択には出るが、有効なラベルにはならない。消えたラベルは、どちらにもならない", () => {
    const t = setup([row("a", true), row("b")], detailsOf(["a", "b"]));
    expect([...t.active.ids()].sort()).toEqual(["a", "b"]);
    expect(t.active.get()?.id).toBe("b");
    t.update({ labels: [row("a", true)] });
    expect(t.active.get()).toBeNull();
  });
});
