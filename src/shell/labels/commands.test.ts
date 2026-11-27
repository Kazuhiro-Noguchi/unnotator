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
  } = {},
) {
  const handlers = new Map<string, () => unknown>();
  const applied: Command[] = [];
  const notes: Array<[string, string]> = [];
  provideLabelHandlers({
    commands: {
      provide(id, run) {
        handlers.set(id, run);
        return { dispose: () => handlers.delete(id) };
      },
    },
    data: {
      labels: () => over.labels ?? [label("l1", 1), label("l2", 2, true)],
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
  return { handlers, applied, notes };
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

  it("選択解除（core.edit.deselect）: 分類が無ければ何もしない。1 つなら delete、複数なら 1 つの transaction", async () => {
    const none = setup();
    await none.handlers.get("core.edit.deselect")?.();
    expect(none.applied).toEqual([]);

    const one = setup({ classification: ["c1"] });
    await one.handlers.get("core.edit.deselect")?.();
    expect(one.applied).toEqual([{ kind: "delete_annotation", id: "c1" }]);

    const many = setup({ classification: ["c1", "c2"] });
    await many.handlers.get("core.edit.deselect")?.();
    expect(many.applied).toEqual([
      {
        kind: "transaction",
        commands: [
          { kind: "delete_annotation", id: "c1" },
          { kind: "delete_annotation", id: "c2" },
        ],
      },
    ]);
  });

  it("選択解除の書き込みに失敗したら、エラーを知らせる", async () => {
    const t = setup({ classification: ["c1"], fail: true });
    await t.handlers.get("core.edit.deselect")?.();
    expect(t.notes[0]?.[0]).toBe("error");
  });
});
