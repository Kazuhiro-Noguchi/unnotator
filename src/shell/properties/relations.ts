// 関係とグループの命令の組み立て。純関数。種別は、拡張機能が無くても使えるコアの型（`core/...`）。
import type { Command } from "../project-data/types";

export const CORE_RELATION_TYPE = "core/relation";
export const CORE_GROUP_TYPE = "core/group";

export type LinkResult =
  | { kind: "apply"; command: Command }
  | { kind: "refuse"; reason: "needTwo" | "self" | "needSome" };

/** 選んだ 2 つのアノテーションを、選んだ順に結ぶ。別のアセットのものでもよい。 */
export function createRelation(selected: readonly string[]): LinkResult {
  const [from, to, ...rest] = selected;
  if (from === undefined || to === undefined || rest.length > 0) {
    return { kind: "refuse", reason: "needTwo" };
  }
  if (from === to) return { kind: "refuse", reason: "self" };
  return {
    kind: "apply",
    command: {
      kind: "create_relation",
      type: CORE_RELATION_TYPE,
      from_id: from,
      to_id: to,
      directed: true,
    },
  };
}

export function createGroup(selected: readonly string[]): LinkResult {
  if (selected.length === 0) return { kind: "refuse", reason: "needSome" };
  return {
    kind: "apply",
    command: {
      kind: "create_group",
      type: CORE_GROUP_TYPE,
      ordered: false,
      members: [...selected],
    },
  };
}

/** 選んだアノテーションを、グループに足す。既にメンバーのものは除く。 */
export function addToGroup(
  groupId: string,
  selected: readonly string[],
  members: readonly string[],
): LinkResult {
  const fresh = selected.filter((id) => !members.includes(id));
  if (fresh.length === 0) return { kind: "refuse", reason: "needSome" };
  return {
    kind: "apply",
    command: {
      kind: "add_group_members",
      group_id: groupId,
      annotation_ids: fresh,
    },
  };
}

export function removeMember(groupId: string, annotationId: string): Command {
  return {
    kind: "remove_group_members",
    group_id: groupId,
    annotation_ids: [annotationId],
  };
}

/** 順序ありのグループで、メンバーを 1 つ上・下へ。端・順序なしは `null`。 */
export function moveMember(
  group: { id: string; ordered: boolean; members: readonly string[] },
  annotationId: string,
  direction: "up" | "down",
): Command | null {
  if (!group.ordered) return null;
  const index = group.members.indexOf(annotationId);
  const to = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || to < 0 || to >= group.members.length) return null;
  return {
    kind: "move_group_member",
    group_id: group.id,
    annotation_id: annotationId,
    to_position: to,
  };
}

/** 解除: 選んだアノテーションを、すべてのグループから外す。グループ自体は残す。 */
export function ungroupSelected(
  groups: ReadonlyArray<{ id: string; members: readonly string[] }>,
  selected: readonly string[],
): LinkResult {
  const commands: Command[] = [];
  for (const group of groups) {
    const hit = group.members.filter((m) => selected.includes(m));
    if (hit.length > 0) {
      commands.push({
        kind: "remove_group_members",
        group_id: group.id,
        annotation_ids: hit,
      });
    }
  }
  const [only] = commands;
  if (only === undefined) return { kind: "refuse", reason: "needSome" };
  return {
    kind: "apply",
    command: commands.length === 1 ? only : { kind: "transaction", commands },
  };
}
