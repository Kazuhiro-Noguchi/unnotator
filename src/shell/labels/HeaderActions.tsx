import { Icon } from "../Icon";
import { useT } from "../solid";
import type { LabelsUi } from "./ui";

/**
 * 「ラベル」の見出しの右端: 絞り込みの切り替え・選択の解除・ラベルの追加（アイコン。追加が右端）。
 * 選択の解除は、コマンド `core.edit.deselect`（ショートカットは Esc）と同じ。
 */
export function LabelsHeaderActions(props: {
  ui: LabelsUi;
  /** 選択中のラベルがあるか（無ければ、解除のアイコンは押せない）。 */
  hasSelection?(): boolean;
  /** 選択の解除。 */
  onDeselect?(): void;
}) {
  const t = useT();
  return (
    <>
      <button
        type="button"
        class="button icon-button"
        aria-label={t("labels.filter")}
        title={t("labels.filter")}
        aria-pressed={props.ui.filterOpen()}
        onClick={() => props.ui.setFilterOpen(!props.ui.filterOpen())}
      >
        <Icon name="$(filter)" size={16} />
      </button>
      <button
        type="button"
        class="button icon-button"
        aria-label={t("labels.deselect")}
        title={t("labels.deselect")}
        disabled={!(props.hasSelection?.() ?? false)}
        onClick={() => props.onDeselect?.()}
      >
        <Icon name="$(circle-x)" size={16} />
      </button>
      <button
        type="button"
        class="button icon-button"
        aria-label={t("labels.add")}
        title={t("labels.add")}
        onClick={() => props.ui.create()}
      >
        <Icon name="$(plus)" size={16} />
      </button>
    </>
  );
}
