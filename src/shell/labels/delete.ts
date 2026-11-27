// ラベルの削除の純関数。使用中のラベルは、付け替えか、一緒に削除かを選ばせる（FR-003）。
import type { Command, LabelRow } from "../project-data/types";

export interface LabelUsageInfo {
  annotations: number;
  relations: number;
  groups: number;
  /** そのラベル専用の属性スキーマ。ラベルを消すと一緒に消えるが、使用中の判定には含めない。 */
  attribute_schemas: number;
}

export type DeleteChoice =
  | { kind: "reassign"; toLabelId: string }
  | { kind: "cascade" };

export function inUse(usage: LabelUsageInfo): boolean {
  return usage.annotations + usage.relations + usage.groups > 0;
}

export function reassignCandidates(
  labels: readonly LabelRow[],
  id: string,
): LabelRow[] {
  return labels.filter((l) => l.id !== id);
}

export function deleteCommand(
  id: string,
  choice: DeleteChoice | null,
): Command {
  return {
    kind: "delete_label",
    id,
    disposition:
      choice === null
        ? null
        : choice.kind === "reassign"
          ? { kind: "reassign", to_label_id: choice.toLabelId }
          : { kind: "cascade" },
  };
}
