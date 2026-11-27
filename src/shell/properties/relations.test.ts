import { describe, expect, it } from "vitest";
import {
  addToGroup,
  CORE_GROUP_TYPE,
  CORE_RELATION_TYPE,
  createGroup,
  createRelation,
  moveMember,
  removeMember,
  ungroupSelected,
} from "./relations";

describe("関係を作る", () => {
  it("選んだ 2 つを、選んだ順に結ぶ（既定は方向あり）", () => {
    expect(createRelation(["a", "b"])).toEqual({
      kind: "apply",
      command: {
        kind: "create_relation",
        type: CORE_RELATION_TYPE,
        from_id: "a",
        to_id: "b",
        directed: true,
      },
    });
  });

  it("2 つでなければ作れない（0・1・3 つ）", () => {
    for (const ids of [[], ["a"], ["a", "b", "c"]]) {
      expect(createRelation(ids)).toEqual({
        kind: "refuse",
        reason: "needTwo",
      });
    }
  });

  it("同じアノテーション同士は結べない", () => {
    expect(createRelation(["a", "a"])).toEqual({
      kind: "refuse",
      reason: "self",
    });
  });
});

describe("グループ", () => {
  it("選んだものを、順序なしのグループにする。1 つ以上必要", () => {
    expect(createGroup(["a", "b"])).toEqual({
      kind: "apply",
      command: {
        kind: "create_group",
        type: CORE_GROUP_TYPE,
        ordered: false,
        members: ["a", "b"],
      },
    });
    expect(createGroup([])).toEqual({ kind: "refuse", reason: "needSome" });
  });

  it("選んだものを、グループに足す（既にあるメンバーは除く）", () => {
    expect(addToGroup("g", ["a", "b", "c"], ["b"])).toEqual({
      kind: "apply",
      command: {
        kind: "add_group_members",
        group_id: "g",
        annotation_ids: ["a", "c"],
      },
    });
    expect(addToGroup("g", ["b"], ["b"])).toEqual({
      kind: "refuse",
      reason: "needSome",
    });
  });

  it("メンバーを外す・並べ替える（順序ありのグループだけ）", () => {
    expect(removeMember("g", "a")).toEqual({
      kind: "remove_group_members",
      group_id: "g",
      annotation_ids: ["a"],
    });
    expect(
      moveMember(
        { id: "g", ordered: true, members: ["a", "b", "c"] },
        "b",
        "up",
      ),
    ).toEqual({
      kind: "move_group_member",
      group_id: "g",
      annotation_id: "b",
      to_position: 0,
    });
    expect(
      moveMember(
        { id: "g", ordered: true, members: ["a", "b", "c"] },
        "a",
        "up",
      ),
    ).toBeNull();
    expect(
      moveMember(
        { id: "g", ordered: true, members: ["a", "b", "c"] },
        "c",
        "down",
      ),
    ).toBeNull();
    expect(
      moveMember({ id: "g", ordered: false, members: ["a", "b"] }, "b", "up"),
    ).toBeNull();
  });

  it("解除: 選んだアノテーションを、すべてのグループから外す（グループは残る）", () => {
    const groups = [
      { id: "g1", members: ["a", "x"] },
      { id: "g2", members: ["y"] },
      { id: "g3", members: ["a", "b"] },
    ];
    expect(ungroupSelected(groups, ["a", "b"])).toEqual({
      kind: "apply",
      command: {
        kind: "transaction",
        commands: [
          {
            kind: "remove_group_members",
            group_id: "g1",
            annotation_ids: ["a"],
          },
          {
            kind: "remove_group_members",
            group_id: "g3",
            annotation_ids: ["a", "b"],
          },
        ],
      },
    });
    expect(ungroupSelected(groups, ["zzz"])).toEqual({
      kind: "refuse",
      reason: "needSome",
    });
  });
});
