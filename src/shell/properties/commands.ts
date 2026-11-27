// 編集系のコマンドの処理（006 の空の処理を置き換える）。いまは `core.edit.delete`（選択中のアノテーションの削除）。
import { format, t } from "../../i18n";
import type { CommandRegistry } from "../commands/registry";
import type { ProjectData } from "../project-data/store";
import type { Command } from "../project-data/types";
import type { Disposable, NotifyLevel } from "../types";
import type { Selection } from "./selection";

export interface EditCommandDeps {
  commands: Pick<CommandRegistry, "provide">;
  data: Pick<ProjectData, "apply">;
  selection: Selection;
  notify(level: NotifyLevel, text: string): void;
}

export function provideEditHandlers(deps: EditCommandDeps): Disposable {
  const handle = deps.commands.provide("core.edit.delete", async () => {
    const ids = [...deps.selection.ids()];
    if (ids.length === 0) return;
    const deletes: Command[] = ids.map((id) => ({
      kind: "delete_annotation",
      id,
    }));
    const [only] = deletes;
    const command: Command =
      deletes.length === 1 && only !== undefined
        ? only
        : { kind: "transaction", commands: deletes };
    try {
      await deps.data.apply(command);
      deps.selection.clear();
    } catch (e) {
      deps.notify(
        "error",
        format(t("properties.saveFailed"), {
          reason: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  });
  return handle;
}
