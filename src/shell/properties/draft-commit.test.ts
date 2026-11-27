import { describe, expect, it } from "vitest";
import { targetKeyOf } from "./draft";
import { draftCommands } from "./draft-commit";

describe("draftCommands（保留の下書きを、書き込みの命令にする）", () => {
  it("アセットのメモは、set_asset_note になる（空は null）", () => {
    expect(
      draftCommands({
        targetKey: targetKeyOf("a1", null),
        fields: [{ field: "note", original: "", value: "メモ" }],
      }),
    ).toEqual([{ kind: "set_asset_note", asset_id: "a1", note: "メモ" }]);
    expect(
      draftCommands({
        targetKey: targetKeyOf("a1", null),
        fields: [{ field: "note", original: "x", value: "" }],
      }),
    ).toEqual([{ kind: "set_asset_note", asset_id: "a1", note: null }]);
  });

  it("アイテムの位置のメモ・知らない欄は、命令にしない", () => {
    expect(
      draftCommands({
        targetKey: targetKeyOf("a1", "page:1"),
        fields: [{ field: "note", original: "", value: "x" }],
      }),
    ).toEqual([]);
    expect(
      draftCommands({
        targetKey: targetKeyOf("a1", null),
        fields: [{ field: "zzz", original: "", value: "x" }],
      }),
    ).toEqual([]);
  });
});
