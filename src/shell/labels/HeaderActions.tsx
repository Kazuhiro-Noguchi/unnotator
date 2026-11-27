import { Icon } from "../Icon";
import { useT } from "../solid";
import type { LabelsUi } from "./ui";

/** 「ラベル」の見出しの右端: 絞り込みの切り替えと、ラベルの追加（アイコン。追加が右端）。 */
export function LabelsHeaderActions(props: { ui: LabelsUi }) {
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
        aria-label={t("labels.add")}
        title={t("labels.add")}
        onClick={() => props.ui.create()}
      >
        <Icon name="$(plus)" size={16} />
      </button>
    </>
  );
}
