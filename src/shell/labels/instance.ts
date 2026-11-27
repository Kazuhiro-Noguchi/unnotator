// ラベルのコマンドを、アプリの実体につなぐ。
import { createRoot } from "solid-js";
import type { CommandRegistry } from "../commands/registry";
import { explorer, itemSource } from "../explorer/instance";
import {
  projectData,
  readClassificationMultiple,
} from "../project-data/instance";
import { ctx } from "../services";
import type { Disposable, NotifyLevel } from "../types";
import { createActiveLabel } from "./active";
import { provideLabelHandlers } from "./commands";
import { labelsUi } from "./ui";

/** 有効なラベル（サイドバーの選択・キーで選んだラベル）。拡張機能の `labels.active()` の元（009 で結ぶ）。 */
export const activeLabel = createRoot(() =>
  createActiveLabel(labelsUi, projectData, ctx),
);

export function provideLabelCommands(
  registry: CommandRegistry,
  notify: (level: NotifyLevel, text: string) => void,
): Disposable {
  return provideLabelHandlers({
    commands: registry,
    data: projectData,
    current: explorer.current,
    multiple: readClassificationMultiple,
    providerOf: (mediaType) => itemSource.traitsOf(mediaType).provider,
    notify,
    select: (id) => labelsUi.setSelected(id),
  });
}
