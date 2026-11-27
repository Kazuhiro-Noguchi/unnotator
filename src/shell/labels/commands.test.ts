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
  } = {},
) {
  const handlers = new Map<string, () => unknown>();
  const applied: Command[] = [];
  const notes: Array<[string, string]> = [];
  const selected: string[] = [];
  provideLabelHandlers({
    commands: {
      provide(id, run) {
        handlers.set(id, run);
        return { dispose: () => handlers.delete(id) };
      },
    },
    data: {
      labels: () => over.labels ?? [label("l1", 1), label("l2", 2, true)],
      details: () => details,
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
    select: (id) => selected.push(id),
  });
  return { handlers, applied, notes, selected };
}

describe("core.label.pick1〜9", () => {
  it("9 つすべてを結ぶ", () => {
    const { handlers } = setup();
    for (let i = 1; i <= 9; i++) {
      expect(handlers.has(`core.label.pick${i}`)).toBe(true);
    }
  });

  it("キーのラベルを、現在位置の分類に付ける", async () => {
    const { handlers, applied, notes } = setup();
    await handlers.get("core.label.pick1")?.();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      kind: "create_annotation",
      type: "core/classification",
      label_id: "l1",
    });
    expect(notes).toEqual([]);
  });

  it("現在位置が無いときは、何もしない（知らせもしない）", async () => {
    const { handlers, applied, notes } = setup({ current: null });
    await handlers.get("core.label.pick1")?.();
    expect(applied).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("非表示のラベルは付けず、理由を知らせる", async () => {
    const { handlers, applied, notes } = setup();
    await handlers.get("core.label.pick2")?.();
    expect(applied).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.[0]).toBe("warn");
  });

  it("割り当てが無いキーは、知らせる", async () => {
    const { handlers, applied, notes } = setup();
    await handlers.get("core.label.pick5")?.();
    expect(applied).toEqual([]);
    expect(notes).toHaveLength(1);
  });

  it("書き込みに失敗したら、エラーを知らせる", async () => {
    const { handlers, notes } = setup({ fail: true });
    await handlers.get("core.label.pick1")?.();
    expect(notes[0]?.[0]).toBe("error");
  });

  it("キーで選んだラベルは、有効なラベルになる（非表示・割り当てなしは、ならない）", async () => {
    const t = setup();
    await t.handlers.get("core.label.pick1")?.();
    expect(t.selected).toEqual(["l1"]);
    await t.handlers.get("core.label.pick2")?.(); // 非表示
    await t.handlers.get("core.label.pick5")?.(); // 割り当てなし
    expect(t.selected).toEqual(["l1"]);
  });

  it("現在位置が無くても、有効なラベルは選べる（分類は付けない）", async () => {
    const t = setup({ current: null });
    await t.handlers.get("core.label.pick1")?.();
    expect(t.selected).toEqual(["l1"]);
    expect(t.applied).toEqual([]);
  });
});
