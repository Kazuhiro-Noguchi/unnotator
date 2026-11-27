// アプリで使うモードのストアと、モードのコマンド。
import type { CommandRegistry } from "../commands/registry";
import { ctx } from "../services";
import type { Disposable } from "../types";
import { createModeStore } from "./store";

export const modeStore = createModeStore(ctx);

/** `core.mode.fileClassification`: ファイル分類のモードを、入れる・切る。 */
export function provideModeCommands(
  registry: Pick<CommandRegistry, "provide">,
): Disposable {
  return registry.provide("core.mode.fileClassification", () =>
    modeStore.toggle("fileClassification"),
  );
}
