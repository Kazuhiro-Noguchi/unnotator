import { createSignal, For, Show } from "solid-js";
import { format } from "../../i18n";
import type { ProjectData } from "../project-data/store";
import type { LabelRow } from "../project-data/types";
import { fromStore, useT } from "../solid";
import type { NotifyLevel } from "../types";
import { LabelForm } from "./LabelForm";
import { filterLabels, nextSortOrder } from "./list";

export interface LabelsViewProps {
  data: Pick<ProjectData, "labels" | "subscribe" | "apply">;
  notify: (level: NotifyLevel, text: string) => void;
}

/** サイドバー「ラベル」。一覧・絞り込み・追加。 */
export function LabelsView(props: LabelsViewProps) {
  const t = useT();
  const labels = fromStore(
    () => props.data.labels(),
    (listener) => props.data.subscribe(listener),
  );
  const [query, setQuery] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const shown = () => filterLabels(labels(), query());

  const create = async (draft: {
    name: string;
    color: string;
    hotkey: number | null;
    hidden: boolean;
  }) => {
    try {
      await props.data.apply({
        kind: "create_label",
        name: draft.name,
        color: draft.color,
        hotkey: draft.hotkey,
        hidden: draft.hidden,
        sort_order: nextSortOrder(labels()),
      });
      setCreating(false);
    } catch (e) {
      props.notify(
        "error",
        format(t("labels.error.failed"), {
          reason: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  return (
    <div class="labels-view">
      <div class="labels-toolbar">
        <input
          type="search"
          class="filter-name"
          placeholder={t("labels.filter")}
          aria-label={t("labels.filter")}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <button
          type="button"
          class="button"
          onClick={() => setCreating(true)}
          disabled={creating()}
        >
          {t("labels.add")}
        </button>
      </div>
      <Show when={creating()}>
        <LabelForm
          label={null}
          labels={labels()}
          onSubmit={(draft) => void create(draft)}
          onCancel={() => setCreating(false)}
        />
      </Show>
      <ul class="label-list">
        <For each={shown()}>{(label) => <LabelItem label={label} />}</For>
      </ul>
      <Show when={shown().length === 0 && labels().length > 0}>
        <p class="label-empty">{t("labels.noMatch")}</p>
      </Show>
    </div>
  );
}

function LabelItem(props: { label: LabelRow }) {
  return (
    <li
      class="label-item"
      classList={{ hidden: props.label.hidden }}
      data-label-id={props.label.id}
    >
      <span
        class="label-swatch"
        style={{ background: props.label.color }}
        aria-hidden="true"
      />
      <span class="label-name">{props.label.name}</span>
      <Show when={props.label.hotkey !== null}>
        <kbd class="label-key">{props.label.hotkey}</kbd>
      </Show>
    </li>
  );
}
