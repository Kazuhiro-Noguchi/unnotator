// ラベルのコマンドを、アプリの実体につなぐ。
import { createRoot } from "solid-js";
import type { CommandRegistry } from "../commands/registry";
import { explorer, itemSource } from "../explorer/instance";
import {
  projectData,
  readClassificationMultiple,
} from "../project-data/instance";
import type { LabelRow } from "../project-data/types";
import { ctx } from "../services";
import type { Disposable, NotifyLevel } from "../types";
import { createActiveLabels } from "./active";
import { pickLabel, provideLabelHandlers } from "./commands";

/** 選択中のラベル = 現在位置の分類。有効なラベルは、拡張機能の `labels.active()` の元（009 で結ぶ）。 */
export const activeLabels = createRoot(() =>
  createActiveLabels(projectData, ctx),
);

/** アプリで使う、ラベルの操作の依存。 */
function pickDeps(notify: (level: NotifyLevel, text: string) => void) {
  return {
    data: projectData,
    current: explorer.current,
    multiple: readClassificationMultiple,
    providerOf: (mediaType: string | null) =>
      itemSource.traitsOf(mediaType).provider,
    notify,
  };
}

export function provideLabelCommands(
  registry: CommandRegistry,
  notify: (level: NotifyLevel, text: string) => void,
): Disposable {
  return provideLabelHandlers({ commands: registry, ...pickDeps(notify) });
}

/** カードのクリック: そのラベルの分類を、現在位置に付ける・外す。 */
export function pickLabelCard(
  notify: (level: NotifyLevel, text: string) => void,
  label: LabelRow,
): Promise<void> {
  return pickLabel(pickDeps(notify), label);
}
