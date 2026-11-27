import { describe, expect, it } from "vitest";
import type { CurrentTarget } from "../explorer/types";
import type { Command, LabelRow, TargetDetails } from "../project-data/types";
import { provideLabelHandlers } from "./commands";

const label = (
  id: string,
  hotkey: number | null,
  hidden = false,
): LabelRow => ({
  id,
  name: id,
  name_i18n_json: "{}",
  color: "#112233",
  hotkey,
  sort_order: 0,
  hidden,
  applies_to_json: "{}",
});

const details: TargetDetails = {
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
  classification: [],
  annotation_count: 0,
  relations: [],
  groups: [],
};

function setup(
  over: {
    current?: CurrentTarget | null;
    labels?: LabelRow[];
    fail?: boolean;
    classification?: string[];
    selected?: string;
  } = {},
) {
  const handlers = new Map<string, () => unknown>();
  const applied: Command[] = [];
  const notes: Array<[string, string]> = [];
  const labels = over.labels ?? [label("l1", 1), label("l2", 2, true)];
  // 選択（有効なラベル）。非表示は、有効にならない。
  let selectedId: string | null = over.selected ?? null;
  provideLabelHandlers({
    active: () => labels.find((l) => l.id === selectedId && !l.hidden) ?? null,
    select: (id) => {
      selectedId = id;
    },
    commands: {
      provide(id, run) {
        handlers.set(id, run);
        return { dispose: () => handlers.delete(id) };
      },
    },
    data: {
      labels: () => labels,
      details: () => ({
        ...details,
        classification: (over.classification ?? []).map((id) => ({
          id,
          type: "core/classification",
          type_version: 1,
          label_id: "l1",
          attributes_json: "{}",
          summary: "",
          z_order: 0,
          source: "manual",
        })),
      }),
      apply: async (command) => {
        if (over.fail) throw new Error("boom");
        applied.push(command);
        return { seq: 1, origin: "apply", changes: [], asset_ids: [] };
      },
    },
    current: {
      get: () =>
        over.current === undefined
          ? { assetId: "a1", itemKey: null, mediaType: null }
          : over.current,
    },
    multiple: async () => false,
    providerOf: () => null,
    notify: (level, text) => notes.push([level, text]),
  });
  return {
    handlers,
    applied,
    notes,
    selected: () => selectedId,
  };
}

describe("ラベルの選択: core.label.pick1〜9・core.edit.deselect", () => {
  it("9 つすべてを結ぶ", () => {
    const { handlers } = setup();
    for (let i = 1; i <= 9; i++) {
      expect(handlers.has(`core.label.pick${i}`)).toBe(true);
    }
  });

  it("キーのラベルを選ぶ。分類は、付かない（書き込みなし）", async () => {
    const { handlers, applied, selected } = setup();
    await handlers.get("core.label.pick1")?.();
    expect(selected()).toBe("l1");
    expect(applied).toEqual([]);
  });

  it("選択中のラベルのキーをもう一度押すと、選択を解除する", async () => {
    const { handlers, selected } = setup({ selected: "l1" });
    await handlers.get("core.label.pick1")?.();
    expect(selected()).toBeNull();
  });

  it("現在位置が無くても、選べる", async () => {
    const { handlers, selected } = setup({ current: null });
    await handlers.get("core.label.pick1")?.();
    expect(selected()).toBe("l1");
  });

  it("非表示のラベルは選べず、理由を知らせる。割り当てが無いキーも、知らせる", async () => {
    const t = setup();
    await t.handlers.get("core.label.pick2")?.();
    expect(t.selected()).toBeNull();
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0]?.[0]).toBe("warn");
    await t.handlers.get("core.label.pick5")?.();
    expect(t.selected()).toBeNull();
    expect(t.notes).toHaveLength(2);
  });

  it("選択解除（core.edit.deselect、Esc）は、選択だけを解除する。分類は、外さない", async () => {
    const t = setup({ selected: "l1", classification: ["c1"] });
    await t.handlers.get("core.edit.deselect")?.();
    expect(t.selected()).toBeNull();
    expect(t.applied).toEqual([]);
  });
});

describe("分類: core.label.classify（選択中のラベルを、現在位置の分類に付ける・外す）", () => {
  it("選択中のラベルを、現在位置の分類に付ける", async () => {
    const { handlers, applied, notes } = setup({ selected: "l1" });
    await handlers.get("core.label.classify")?.();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      kind: "create_annotation",
      type: "core/classification",
      label_id: "l1",
    });
    expect(notes).toEqual([]);
  });

  it("付いていれば、外す", async () => {
    const { handlers, applied } = setup({
      selected: "l1",
      classification: ["c1"],
    });
    await handlers.get("core.label.classify")?.();
    expect(applied).toEqual([{ kind: "delete_annotation", id: "c1" }]);
  });

  it("ラベルを選んでいないときは、知らせる（書き込みなし）", async () => {
    const { handlers, applied, notes } = setup();
    await handlers.get("core.label.classify")?.();
    expect(applied).toEqual([]);
    expect(notes).toHaveLength(1);
  });

  it("現在位置が無いときは、何もしない（知らせもしない）", async () => {
    const { handlers, applied, notes } = setup({
      selected: "l1",
      current: null,
    });
    await handlers.get("core.label.classify")?.();
    expect(applied).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("書き込みに失敗したら、エラーを知らせる", async () => {
    const { handlers, notes } = setup({ selected: "l1", fail: true });
    await handlers.get("core.label.classify")?.();
    expect(notes[0]?.[0]).toBe("error");
  });
});
