// ラベルのコマンドと、選択（有効なラベル）を、アプリの実体につなぐ。
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
import { createActiveLabel } from "./active";
import {
  classifyActiveLabel,
  type LabelClassifyDeps,
  provideLabelHandlers,
  selectLabel,
} from "./commands";
import { labelsUi } from "./ui";

/** 有効なラベル = 選択中のラベル。拡張機能の `labels.active()` の元（009 で結ぶ）。 */
export const activeLabel = createRoot(() =>
  createActiveLabel(labelsUi, projectData, ctx),
);

/** アプリで使う、ラベルの操作の依存。 */
function deps(
  notify: (level: NotifyLevel, text: string) => void,
): LabelClassifyDeps {
  return {
    active: activeLabel.get,
    select: (id) => labelsUi.setSelected(id),
    data: projectData,
    current: explorer.current,
    multiple: readClassificationMultiple,
    providerOf: (mediaType) => itemSource.traitsOf(mediaType).provider,
    notify,
  };
}

export function provideLabelCommands(
  registry: CommandRegistry,
  notify: (level: NotifyLevel, text: string) => void,
): Disposable {
  return provideLabelHandlers({ commands: registry, ...deps(notify) });
}

/** カードのクリック: そのラベルを選ぶ（選択中なら、解除する）。 */
export function selectLabelCard(
  notify: (level: NotifyLevel, text: string) => void,
  label: LabelRow,
): void {
  selectLabel(deps(notify), label);
}

/** 選択中のラベルを、現在位置の分類として付ける・外す。 */
export function classifyActive(
  notify: (level: NotifyLevel, text: string) => void,
): Promise<void> {
  return classifyActiveLabel(deps(notify));
}
