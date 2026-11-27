// 保留の下書きを、書き込みの命令にする。メモはアセット単位だけ（アイテムにメモの列は無い）。
import type { Command } from "../project-data/types";
import { type Draft, parseTargetKey } from "./draft";

export function draftCommands(draft: Draft): Command[] {
  const { assetId, itemKey } = parseTargetKey(draft.targetKey);
  const commands: Command[] = [];
  for (const f of draft.fields) {
    if (f.field === "note" && itemKey === null) {
      commands.push({
        kind: "set_asset_note",
        asset_id: assetId,
        note: f.value === "" ? null : f.value,
      });
    }
  }
  return commands;
}
