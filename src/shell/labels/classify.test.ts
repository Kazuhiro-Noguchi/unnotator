import { describe, expect, it } from "vitest";
import type {
  AnnotationRow,
  LabelRow,
  TargetDetails,
} from "../project-data/types";
import { classify, classifyMany, labelForKey } from "./classify";

function label(id: string, over: Partial<LabelRow> = {}): LabelRow {
  return {
    id,
    name: id,
    name_i18n_json: "{}",
    color: "#112233",
    hotkey: null,
    sort_order: 0,
    hidden: false,
    applies_to_json: "{}",
    ...over,
  };
}

function existing(id: string, labelId: string | null): AnnotationRow {
  return {
    id,
    type: "core/classification",
    type_version: 1,
    label_id: labelId,
    attributes_json: "{}",
    summary: "",
    z_order: 0,
    source: "manual",
  };
}

function details(
  classification: AnnotationRow[],
  item: TargetDetails["item"] = null,
): TargetDetails {
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
    item,
    classification,
    annotation_count: classification.length,
    relations: [],
    groups: [],
  };
}

const here = { assetId: "a1", itemKey: null, mediaType: "x/image" };
const base = { current: here, provider: null, multiple: false };

describe("classify（分類の付け方）", () => {
  it("付いていなければ、付ける（selector は空）", () => {
    const r = classify({ ...base, label: label("l1"), details: details([]) });
    expect(r).toEqual({
      kind: "apply",
      command: {
        kind: "create_annotation",
        target: { asset_id: "a1", item: null },
        type: "core/classification",
        selector_json: "{}",
        label_id: "l1",
      },
    });
  });

  it("同じラベルが付いていれば、外す", () => {
    const r = classify({
      ...base,
      label: label("l1"),
      details: details([existing("c1", "l1")]),
    });
    expect(r).toEqual({
      kind: "apply",
      command: { kind: "delete_annotation", id: "c1" },
    });
  });

  it("単一では、別のラベルへの付け替えが 1 つの Transaction になる", () => {
    const r = classify({
      ...base,
      label: label("l2"),
      details: details([existing("c1", "l1")]),
    });
    expect(r.kind).toBe("apply");
    if (r.kind !== "apply") return;
    expect(r.command.kind).toBe("transaction");
    if (r.command.kind !== "transaction") return;
    expect(r.command.commands.map((c) => c.kind)).toEqual([
      "delete_annotation",
      "create_annotation",
    ]);
  });

  it("複数を許すと、別のラベルは追加になる", () => {
    const r = classify({
      ...base,
      multiple: true,
      label: label("l2"),
      details: details([existing("c1", "l1")]),
    });
    expect(r).toMatchObject({
      kind: "apply",
      command: { kind: "create_annotation", label_id: "l2" },
    });
  });

  it("複数でも、同じラベルは外す（そのラベルの分だけ）", () => {
    const r = classify({
      ...base,
      multiple: true,
      label: label("l2"),
      details: details([existing("c1", "l1"), existing("c2", "l2")]),
    });
    expect(r).toEqual({
      kind: "apply",
      command: { kind: "delete_annotation", id: "c2" },
    });
  });

  it("アイテムの位置では、アイテムに付ける（提供元が要る）", () => {
    const current = { ...here, itemKey: "page:3" };
    const r = classify({
      ...base,
      current,
      provider: "p/pages",
      label: label("l1"),
      details: details([]),
    });
    expect(r).toMatchObject({
      kind: "apply",
      command: {
        target: {
          asset_id: "a1",
          item: { asset_id: "a1", item_key: "page:3", provider: "p/pages" },
        },
      },
    });
    expect(
      classify({
        ...base,
        current,
        provider: null,
        label: label("l1"),
        details: details([]),
      }),
    ).toEqual({ kind: "refuse", reason: "noProvider" });
  });

  it("付けられないときは、理由を返す", () => {
    const d = details([]);
    expect(
      classify({ ...base, current: null, label: label("l1"), details: d }),
    ).toEqual({ kind: "refuse", reason: "noCurrent" });
    expect(classify({ ...base, label: undefined, details: d })).toEqual({
      kind: "refuse",
      reason: "noLabel",
    });
    expect(
      classify({ ...base, label: label("l1", { hidden: true }), details: d }),
    ).toEqual({ kind: "refuse", reason: "hidden" });
    expect(
      classify({
        ...base,
        label: label("l1", { applies_to_json: '{"classification":false}' }),
        details: d,
      }),
    ).toEqual({ kind: "refuse", reason: "notAllowed" });
    expect(
      classify({
        ...base,
        label: label("l1", { applies_to_json: '{"mediaTypes":["x/audio"]}' }),
        details: d,
      }),
    ).toEqual({ kind: "refuse", reason: "notAllowed" });
  });

  it("詳細がまだ読めていないときは、何もしない", () => {
    expect(classify({ ...base, label: label("l1"), details: null })).toEqual({
      kind: "refuse",
      reason: "noCurrent",
    });
  });
});

describe("labelForKey（ショートカットキーのラベル）", () => {
  it("ショートカットキーに割り当てたラベルを返す", () => {
    const labels = [label("a", { hotkey: 1 }), label("b", { hotkey: 3 })];
    expect(labelForKey(labels, 3)?.id).toBe("b");
    expect(labelForKey(labels, 2)).toBeUndefined();
  });
});

describe("classifyMany（選択中の複数のラベルを、まとめて）", () => {
  const two = [label("l1"), label("l2")];
  const many = { ...base, labels: two, multiple: true };

  it("1 つなら、classify と同じ", () => {
    expect(
      classifyMany({ ...base, labels: [label("l1")], details: details([]) }),
    ).toEqual(classify({ ...base, label: label("l1"), details: details([]) }));
  });

  it("ラベルが無ければ、noLabel。単一の設定で複数なら、needMultiple", () => {
    expect(classifyMany({ ...base, labels: [], details: details([]) })).toEqual(
      {
        kind: "refuse",
        reason: "noLabel",
      },
    );
    expect(
      classifyMany({ ...base, labels: two, details: details([]) }),
    ).toEqual({ kind: "refuse", reason: "needMultiple" });
  });

  it("どれも付いていなければ、すべてを付ける（1 つの transaction）", () => {
    const r = classifyMany({ ...many, details: details([]) });
    expect(r.kind).toBe("apply");
    if (r.kind !== "apply" || r.command.kind !== "transaction") {
      throw new Error("transaction のはず");
    }
    expect(r.command.commands.map((c) => c.kind)).toEqual([
      "create_annotation",
      "create_annotation",
    ]);
  });

  it("一部が付いていれば、付いていないものだけを付ける", () => {
    const r = classifyMany({
      ...many,
      details: details([existing("c1", "l1")]),
    });
    expect(r).toMatchObject({
      kind: "apply",
      command: { kind: "create_annotation", label_id: "l2" },
    });
  });

  it("すべて付いていれば、選択中のラベルの分類を、すべて外す（ほかのラベルは残す）", () => {
    const r = classifyMany({
      ...many,
      details: details([
        existing("c1", "l1"),
        existing("c2", "l2"),
        existing("c3", "l9"),
      ]),
    });
    expect(r).toEqual({
      kind: "apply",
      command: {
        kind: "transaction",
        commands: [
          { kind: "delete_annotation", id: "c1" },
          { kind: "delete_annotation", id: "c2" },
        ],
      },
    });
  });

  it("付けられないラベルが混ざっていれば、理由を返して、何もしない", () => {
    const blocked = label("l2", {
      applies_to_json: '{"classification":false}',
    });
    expect(
      classifyMany({
        ...many,
        labels: [label("l1"), blocked],
        details: details([]),
      }),
    ).toEqual({ kind: "refuse", reason: "notAllowed" });
  });
});
