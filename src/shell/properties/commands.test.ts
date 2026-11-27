import { describe, expect, it } from "vitest";
import type { Command } from "../project-data/types";
import { provideEditHandlers } from "./commands";
import { createSelection } from "./selection";

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
