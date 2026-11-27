// 属性スキーマの編集画面を開くコマンド（006 の空の処理を置き換える）。
import type { CommandRegistry } from "../commands/registry";
import type { Disposable } from "../types";
import { setSchemaOpen } from "../ui-state";

export function provideSchemaCommands(
  registry: Pick<CommandRegistry, "provide">,
): Disposable {
  return registry.provide("core.project.schema", () => setSchemaOpen(true));
}
