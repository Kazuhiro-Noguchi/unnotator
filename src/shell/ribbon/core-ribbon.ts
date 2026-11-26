// コアのリボンの定義（specs/006-shell-layout/contracts/core-catalog.md の「コアのリボン」）。
// 設計書 3.1 に従い、媒体固有の表示操作はここに置かない（エディターがグループを追加する）。
import type { RibbonControl, RibbonGroup, RibbonTab, Title } from "../types";

const title = (ja: string, en: string): Title => ({ ja, en });

const large = (command: string, args?: unknown): RibbonControl =>
  args === undefined
    ? { kind: "largeButton", command }
    : { kind: "largeButton", command, args };
const small = (command: string, args?: unknown): RibbonControl =>
  args === undefined
    ? { kind: "smallButton", command }
    : { kind: "smallButton", command, args };
/** ラベルなしの、アイコンだけの小ボタン。 */
const iconButton = (command: string): RibbonControl => ({
  kind: "smallButton",
  command,
  iconOnly: true,
});
const toggle = (command: string, checked?: string): RibbonControl =>
  checked === undefined
    ? { kind: "toggle", command }
    : { kind: "toggle", command, checked };

function group(
  id: string,
  ja: string,
  en: string,
  priority: number,
  controls: RibbonControl[],
): RibbonGroup {
  return { id, title: title(ja, en), priority, controls, source: "core" };
}

function tab(
  id: string,
  ja: string,
  en: string,
  order: number,
  keytip: string,
  groups: RibbonGroup[],
): RibbonTab {
  return {
    id,
    title: title(ja, en),
    order,
    groups,
    contextual: false,
    source: "core",
    keytip,
  };
}

export function coreRibbon(): RibbonTab[] {
  return [
    tab("home", "ホーム", "Home", 10, "H", [
      group("home.clipboard", "クリップボード", "Clipboard", 10, [
        large("core.edit.paste"),
        iconButton("core.edit.cut"),
        iconButton("core.edit.copy"),
      ]),
      group("home.edit", "編集", "Edit", 20, [
        small("core.edit.delete"),
        small("core.edit.selectAll"),
        small("core.edit.duplicate"),
      ]),
      group("home.tools", "ツール", "Tools", 40, [toggle("core.tool.select")]),
      group("home.relations", "関係とグループ", "Relations and groups", 30, [
        small("core.relation.create"),
        small("core.group.create"),
        small("core.group.ungroup"),
      ]),
      group("home.status", "状態", "Status", 70, [
        small("core.status.markDone"),
        small("core.status.needsReview"),
      ]),
      // 表示の切替（アノテーション・ラベル名）。
      group("home.view", "表示", "View", 35, [
        toggle("core.view.annotations.toggle"),
        toggle("core.view.labelNames.toggle"),
      ]),
      // プロジェクトの定義（設定とスキーマ）。
      group("home.project", "プロジェクト", "Project", 80, [
        large("core.project.settings"),
        large("core.project.schema"),
      ]),
    ]),
  ];
}
