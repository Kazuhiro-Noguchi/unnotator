// 編集系のコマンドの処理（006 の空の処理を置き換える）。
// `core.edit.delete`（選択中のアノテーションの削除）、`core.relation.create`、`core.group.create`、`core.group.ungroup`。
import { format, t } from "../../i18n";
import type { CommandRegistry } from "../commands/registry";
import type { ProjectData } from "../project-data/store";
import type { Command } from "../project-data/types";
import type { Disposable, NotifyLevel } from "../types";
import {
  createGroup,
  createRelation,
  type LinkResult,
  ungroupSelected,
} from "./relations";
import type { Selection } from "./selection";

export interface EditCommandDeps {
  commands: Pick<CommandRegistry, "provide">;
  data: Pick<ProjectData, "apply" | "details">;
  selection: Selection;
  notify(level: NotifyLevel, text: string): void;
}

export function provideEditHandlers(deps: EditCommandDeps): Disposable {
  const handles: Disposable[] = [];
  const fail = (e: unknown) =>
    deps.notify(
      "error",
      format(t("properties.saveFailed"), {
        reason: e instanceof Error ? e.message : String(e),
      }),
    );

  handles.push(
    deps.commands.provide("core.edit.delete", async () => {
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
        fail(e);
      }
    }),
  );

  /** 選択から命令を作り、書く。作れないときは、理由を知らせる。 */
  const link = (build: (selected: string[]) => LinkResult) => async () => {
    const result = build([...deps.selection.ids()]);
    if (result.kind === "refuse") {
      // 何も選んでいないときの Ctrl+L / Ctrl+G は、黙って何もしない。
      if (deps.selection.ids().size === 0) return;
      deps.notify(
        "warn",
        t(
          result.reason === "needTwo"
            ? "relations.needTwo"
            : result.reason === "self"
              ? "relations.self"
              : "groups.needSome",
        ),
      );
      return;
    }
    try {
      await deps.data.apply(result.command);
    } catch (e) {
      fail(e);
    }
  };
  handles.push(
    deps.commands.provide("core.relation.create", link(createRelation)),
    deps.commands.provide("core.group.create", link(createGroup)),
    deps.commands.provide(
      "core.group.ungroup",
      link((selected) =>
        ungroupSelected(deps.data.details()?.groups ?? [], selected),
      ),
    ),
  );

  return {
    dispose() {
      for (const handle of handles) handle.dispose();
    },
  };
}
