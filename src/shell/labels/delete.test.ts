import { describe, expect, it } from "vitest";
import type { LabelRow } from "../project-data/types";
import { deleteCommand, inUse, reassignCandidates } from "./delete";

const row = (id: string, name: string, hidden = false): LabelRow => ({
  id,
  name,
  name_i18n_json: "{}",
  color: "#112233",
  hotkey: null,
  sort_order: 0,
  hidden,
  applies_to_json: "{}",
});

describe("ラベルの削除", () => {
  it("使われているかは、アノテーション・関係・グループの合計で決める", () => {
    expect(
      inUse({ annotations: 0, relations: 0, groups: 0, attribute_schemas: 0 }),
    ).toBe(false);
    expect(
      inUse({ annotations: 0, relations: 1, groups: 0, attribute_schemas: 0 }),
    ).toBe(true);
    expect(
      inUse({ annotations: 0, relations: 0, groups: 0, attribute_schemas: 1 }),
    ).toBe(false);
  });

  it("付け替えの候補は、自分以外のラベル（非表示も含める）", () => {
    const labels = [row("a", "a"), row("b", "b", true), row("c", "c")];
    expect(reassignCandidates(labels, "a").map((l) => l.id)).toEqual([
      "b",
      "c",
    ]);
  });

  it("未使用は、選択なしの delete_label。使用中は、付け替えか一緒に削除", () => {
    expect(deleteCommand("a", null)).toEqual({
      kind: "delete_label",
      id: "a",
      disposition: null,
    });
    expect(deleteCommand("a", { kind: "reassign", toLabelId: "b" })).toEqual({
      kind: "delete_label",
      id: "a",
      disposition: { kind: "reassign", to_label_id: "b" },
    });
    expect(deleteCommand("a", { kind: "cascade" })).toEqual({
      kind: "delete_label",
      id: "a",
      disposition: { kind: "cascade" },
    });
  });
});
