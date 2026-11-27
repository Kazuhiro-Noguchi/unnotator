import { describe, expect, it } from "vitest";
import type { Command, TargetDetails } from "../project-data/types";
import { provideEditHandlers } from "./commands";
import { createSelection } from "./selection";

const detailsWithGroup = {
  groups: [{ id: "g1", members: ["a", "x"] }],
} as unknown as TargetDetails;

function setup(fail = false) {
  const handlers = new Map<string, () => unknown>();
  const applied: Command[] = [];
  const notes: string[] = [];
  const selection = createSelection();
  provideEditHandlers({
    commands: {
      provide(id, run) {
        handlers.set(id, run);
        return { dispose: () => handlers.delete(id) };
      },
    },
    data: {
      details: () => detailsWithGroup,
      apply: async (command) => {
        if (fail) throw new Error("boom");
        applied.push(command);
        return { seq: 1, origin: "apply", changes: [], asset_ids: [] };
      },
    },
    selection,
    notify: (_level, text) => notes.push(text),
  });
  return { handlers, applied, notes, selection };
}

describe("core.edit.delete", () => {
  it("何も選んでいなければ、何もしない", async () => {
    const { handlers, applied } = setup();
    await handlers.get("core.edit.delete")?.();
    expect(applied).toEqual([]);
  });

  it("1 件なら delete_annotation、複数なら 1 つの transaction（1 回の元に戻す）", async () => {
    const t = setup();
    t.selection.select("a", false);
    await t.handlers.get("core.edit.delete")?.();
    expect(t.applied).toEqual([{ kind: "delete_annotation", id: "a" }]);
    t.selection.select("a", false);
    t.selection.select("b", true);
    await t.handlers.get("core.edit.delete")?.();
    expect(t.applied[1]).toEqual({
      kind: "transaction",
      commands: [
        { kind: "delete_annotation", id: "a" },
        { kind: "delete_annotation", id: "b" },
      ],
    });
  });

  it("失敗したら、エラーを知らせる", async () => {
    const t = setup(true);
    t.selection.select("a", false);
    await t.handlers.get("core.edit.delete")?.();
    expect(t.notes).toHaveLength(1);
  });
});

describe("関係・グループのコマンド", () => {
  it("2 つ選んで core.relation.create → create_relation", async () => {
    const t = setup();
    t.selection.select("a", false);
    t.selection.select("b", true);
    await t.handlers.get("core.relation.create")?.();
    expect(t.applied[0]).toMatchObject({
      kind: "create_relation",
      from_id: "a",
      to_id: "b",
    });
  });

  it("何も選んでいなければ黙って何もしない。1 つだけなら、理由を知らせる", async () => {
    const t = setup();
    await t.handlers.get("core.relation.create")?.();
    expect(t.notes).toEqual([]);
    t.selection.select("a", false);
    await t.handlers.get("core.relation.create")?.();
    expect(t.notes).toHaveLength(1);
    expect(t.applied).toEqual([]);
  });

  it("core.group.create はグループを作り、core.group.ungroup はメンバーから外す", async () => {
    const t = setup();
    t.selection.select("a", false);
    await t.handlers.get("core.group.create")?.();
    expect(t.applied[0]).toMatchObject({
      kind: "create_group",
      members: ["a"],
    });
    await t.handlers.get("core.group.ungroup")?.();
    expect(t.applied[1]).toEqual({
      kind: "remove_group_members",
      group_id: "g1",
      annotation_ids: ["a"],
    });
  });
});
