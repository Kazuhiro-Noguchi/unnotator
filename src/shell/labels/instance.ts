// ラベルのコマンドと、選択（有効なラベル）を、アプリの実体につなぐ。
import { createRoot } from "solid-js";
import { t } from "../../i18n";
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
  classifyActiveLabels,
  type LabelClassifyDeps,
  provideLabelHandlers,
} from "./commands";
import type { ClickMode } from "./selection";
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
    selected: activeLabel.selected,
    // ショートカットキーは、全ラベルの並びで、範囲の計算はしない（通常のクリックと同じ扱い）。
    click: (id, mode) =>
      labelsUi.click(
        id,
        mode,
        projectData.labels().map((l) => l.id),
      ),
    clear: () => labelsUi.clearSelection(),
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

/** カードのクリック: そのラベルを選ぶ（通常・Ctrl / Cmd・Shift）。範囲の並びは、見えているラベル（`order`）。 */
export function selectLabelCard(
  notify: (level: NotifyLevel, text: string) => void,
  label: LabelRow,
  mode: ClickMode,
  order: readonly string[],
): void {
  if (label.hidden) {
    notify("warn", t("labels.pick.hidden"));
    return;
  }
  labelsUi.click(label.id, mode, order);
}

/** 選択中のラベルを、現在位置の分類として付ける・外す。 */
export function classifyActive(
  notify: (level: NotifyLevel, text: string) => void,
): Promise<void> {
  return classifyActiveLabels(deps(notify));
}
