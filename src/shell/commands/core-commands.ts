// コアのコマンドの一覧（specs/006-shell-layout/contracts/core-catalog.md）。
// 実装済みの処理は core-handlers.ts が `provide` で結ぶ。結ばれていないものは「未提供」（無効）で並ぶ。
import type { CommandSpec } from "../types";
import type { CommandRegistry } from "./registry";

export interface CoreKey {
  key: string;
  when?: string;
}

export interface CoreCommandDef {
  id: string;
  ja: string;
  en: string;
  icon?: string;
  /** コマンドの実行できる条件（when 式）。 */
  enablement?: string;
  keys?: CoreKey[];
}

const NOT_IN_INPUT = "!inputFocus";

function def(
  id: string,
  ja: string,
  en: string,
  extra: Partial<Omit<CoreCommandDef, "id" | "ja" | "en">> = {},
): CoreCommandDef {
  return { id, ja, en, ...extra };
}

const LABEL_PICKS = Array.from({ length: 9 }, (_, i) =>
  def(`core.label.pick${i + 1}`, `ラベル ${i + 1}`, `Label ${i + 1}`, {
    icon: "$(tag)",
    keys: [{ key: `${i + 1}`, when: NOT_IN_INPUT }],
  }),
);

export const CORE_COMMANDS: readonly CoreCommandDef[] = [
  // 元に戻す・保存・開く
  def("core.undo", "元に戻す", "Undo", {
    icon: "$(undo)",
    enablement: "canUndo",
    keys: [{ key: "Ctrl+Z" }],
  }),
  def("core.redo", "やり直し", "Redo", {
    icon: "$(redo)",
    enablement: "canRedo",
    keys: [{ key: "Ctrl+Y" }, { key: "Ctrl+Shift+Z" }],
  }),
  def("core.project.save", "保存", "Save", {
    icon: "$(save)",
    enablement: "projectOpen",
    keys: [{ key: "Ctrl+S" }],
  }),
  def("core.project.open", "開く", "Open", {
    icon: "$(open)",
    keys: [{ key: "Ctrl+O" }],
  }),
  def("core.project.new", "新規", "New", {
    icon: "$(new)",
  }),
  def("core.project.openRecent", "最近のプロジェクト", "Recent", {
    icon: "$(recent)",
  }),
  def("core.project.duplicate", "フォルダへ複製", "Duplicate to folder", {
    icon: "$(duplicate)",
    enablement: "projectOpen",
  }),
  def("core.project.import", "インポート", "Import", {
    icon: "$(install)",
    enablement: "projectOpen",
  }),
  def("core.project.export", "エクスポート", "Export", {
    icon: "$(output)",
    enablement: "projectOpen",
  }),
  def("core.app.settings", "設定", "Settings", { icon: "$(settings)" }),
  def("core.app.about", "バージョン情報", "About", { icon: "$(info)" }),
  def("core.palette.open", "コマンドパレット", "Command palette", {
    icon: "$(command)",
    keys: [{ key: "Ctrl+Shift+P" }],
  }),

  // 編集
  def("core.edit.delete", "削除", "Delete", {
    icon: "$(delete)",
    keys: [{ key: "Delete", when: NOT_IN_INPUT }],
  }),
  def("core.edit.duplicate", "複製", "Duplicate", {
    icon: "$(duplicate)",
    keys: [{ key: "Ctrl+D" }],
  }),
  def("core.edit.selectAll", "全選択", "Select all", {
    icon: "$(select-all)",
    keys: [{ key: "Ctrl+A" }],
  }),
  def("core.edit.deselect", "選択解除", "Deselect", {
    keys: [{ key: "Escape", when: NOT_IN_INPUT }],
  }),
  def("core.edit.copy", "コピー", "Copy", {
    icon: "$(copy)",
    keys: [{ key: "Ctrl+C" }],
  }),
  def("core.edit.cut", "切り取り", "Cut", {
    icon: "$(cut)",
    keys: [{ key: "Ctrl+X" }],
  }),
  def("core.edit.paste", "貼り付け", "Paste", {
    icon: "$(paste)",
    keys: [{ key: "Ctrl+V" }],
  }),
  def("core.select.next", "次の選択", "Next selection", {
    keys: [{ key: "Tab", when: NOT_IN_INPUT }],
  }),
  def("core.select.prev", "前の選択", "Previous selection", {
    keys: [{ key: "Shift+Tab", when: NOT_IN_INPUT }],
  }),

  // ナビゲーションと状態
  def("core.nav.prev", "前へ", "Previous", {
    icon: "$(prev)",
    keys: [{ key: "PageUp", when: NOT_IN_INPUT }],
  }),
  def("core.nav.next", "次へ", "Next", {
    icon: "$(next)",
    keys: [{ key: "PageDown", when: NOT_IN_INPUT }],
  }),
  def("core.nav.markDoneAndNext", "完了して次へ", "Done and next", {
    icon: "$(next-unfinished)",
    keys: [{ key: "Ctrl+Enter" }],
  }),
  def("core.nav.nextUnfinished", "次の未完了", "Next unfinished", {
    icon: "$(next-unfinished)",
    keys: [{ key: "Ctrl+Shift+N" }],
  }),
  def("core.status.markDone", "完了", "Done", { icon: "$(check)" }),
  def("core.status.needsReview", "要確認", "Review", { icon: "$(flag)" }),

  // ラベル・関係・グループ
  ...LABEL_PICKS,
  def("core.relation.create", "関係", "Relation", {
    icon: "$(relation)",
    keys: [{ key: "Ctrl+L" }],
  }),
  def("core.group.create", "グループ", "Group", {
    icon: "$(group)",
    keys: [{ key: "Ctrl+G" }],
  }),
  def("core.group.ungroup", "解除", "Ungroup", { icon: "$(ungroup)" }),
  def("core.tool.select", "選択", "Select", { icon: "$(cursor)" }),

  // 表示
  def("core.view.annotations.toggle", "アノテーション", "Annotations", {
    icon: "$(eye)",
    keys: [{ key: "Ctrl+H" }],
  }),
  def("core.view.labelNames.toggle", "ラベル名", "Label names", {
    icon: "$(label-name)",
  }),
  def(
    "core.view.primarySidebar.toggle",
    "プライマリサイドバー",
    "Primary sidebar",
    {
      icon: "$(primary-sidebar)",
    },
  ),
  def(
    "core.view.secondarySidebar.toggle",
    "セカンダリサイドバー",
    "Secondary sidebar",
    {
      icon: "$(secondary-sidebar)",
    },
  ),
  def("core.view.bottom.toggle", "ボトムパネル", "Bottom panel", {
    icon: "$(bottom-panel)",
  }),
  def("core.view.theme.set", "テーマ", "Theme", { icon: "$(theme)" }),
  def("core.view.language.set", "言語", "Language", {
    icon: "$(language)",
  }),

  // プロジェクトの設定
  // ラベル・関係・グループの種類・属性スキーマを、1 つの編集画面（008）で扱う。
  def("core.project.schema", "スキーマ", "Schema", {
    icon: "$(schema)",
    enablement: "projectOpen",
  }),
  // プロジェクトの設定（除外パターン・外部フォルダ・監視など。画面は 007 以降）
  def("core.project.settings", "プロジェクト設定", "Project settings", {
    icon: "$(project-settings)",
    enablement: "projectOpen",
  }),
  // 拡張機能（管理画面は 011。サイドバーの「拡張機能」の中に置く）
  def("core.extensions.manage", "管理", "Manage", {
    icon: "$(extension)",
  }),
  def("core.extensions.install", "インストール", "Install", {
    icon: "$(install)",
  }),
  def("core.extensions.devMode", "開発者モード", "Developer mode", {
    icon: "$(developer)",
  }),
  def("core.extensions.pythonJobs", "Python ジョブ", "Python jobs", {
    icon: "$(jobs)",
  }),

  // サイドバーの入口
  def("core.primarySidebar.show.explorer", "エクスプローラー", "Explorer", {
    icon: "$(explorer)",
  }),
  def("core.primarySidebar.show.labels", "ラベル", "Labels", {
    icon: "$(tag)",
  }),
  def("core.primarySidebar.show.search", "検索", "Search", {
    icon: "$(search)",
  }),
  def("core.primarySidebar.show.extensions", "拡張機能", "Extensions", {
    icon: "$(extension)",
  }),
];

/** コアのコマンドを、すべて「未提供」で宣言する。処理は `core-handlers.ts` が結ぶ。 */
export function declareCoreCommands(registry: CommandRegistry): void {
  for (const command of CORE_COMMANDS) {
    const spec: CommandSpec = {
      id: command.id,
      title: { ja: command.ja, en: command.en },
      source: "core",
    };
    if (command.icon !== undefined) spec.icon = command.icon;
    if (command.enablement !== undefined) spec.enablement = command.enablement;
    registry.declare(spec);
  }
}
