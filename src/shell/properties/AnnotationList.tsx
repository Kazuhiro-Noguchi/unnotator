import { createSignal, For, Show } from "solid-js";
import { format } from "../../i18n";
import type { AnnotationRow, LabelRow } from "../project-data/types";
import { useT } from "../solid";
import { isSupportedType } from "./unsupported";
import { visibleWindow } from "./window";

export const ROW_HEIGHT = 32;
const OVERSCAN = 5;
const FALLBACK_VISIBLE = 12;

export interface AnnotationListProps {
  rows: readonly AnnotationRow[];
  labels: readonly LabelRow[];
  supported: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  onSelect: (id: string, multi: boolean) => void;
  onLabel: (id: string, labelId: string | null) => void;
  onDelete: (id: string) => void;
}

/** アノテーションの一覧（仮想スクロール）。未対応の種別も、ラベル・削除はできる。 */
export function AnnotationList(props: AnnotationListProps) {
  const t = useT();
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(0);
  const window = () =>
    visibleWindow(
      scrollTop(),
      height() || ROW_HEIGHT * FALLBACK_VISIBLE,
      ROW_HEIGHT,
      props.rows.length,
      OVERSCAN,
    );
  const shown = () => props.rows.slice(window().start, window().end);

  return (
    <Show
      when={props.rows.length > 0}
      fallback={<p class="prop-empty">{t("properties.annotations.none")}</p>}
    >
      <div
        class="annotation-list"
        role="listbox"
        aria-multiselectable="true"
        ref={(el) => {
          queueMicrotask(() => setHeight(el.clientHeight));
        }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div
          class="annotation-body"
          style={{ height: `${props.rows.length * ROW_HEIGHT}px` }}
        >
          <For each={shown()}>
            {(row, i) => (
              <AnnotationItem
                row={row}
                top={(window().start + i()) * ROW_HEIGHT}
                {...props}
              />
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}

function AnnotationItem(
  props: AnnotationListProps & {
    row: AnnotationRow;
    top: number;
  },
) {
  const t = useT();
  const unsupported = () => !isSupportedType(props.row.type, props.supported);
  const title = () =>
    unsupported()
      ? format(t("properties.unsupported"), { type: props.row.type })
      : props.row.summary || props.row.type;
  return (
    <div
      class="annotation-item"
      classList={{
        selected: props.selected.has(props.row.id),
        unsupported: unsupported(),
      }}
      role="option"
      tabIndex={0}
      aria-selected={props.selected.has(props.row.id)}
      style={{ top: `${props.top}px`, height: `${ROW_HEIGHT}px` }}
      title={unsupported() ? t("properties.unsupported.hint") : props.row.type}
      onKeyDown={(event) => {
        // 一覧の中の入力欄・ボタンのキーは、ここで扱わない。
        if (event.target !== event.currentTarget) return;
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          props.onSelect(props.row.id, event.ctrlKey || event.metaKey);
        } else if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          props.onDelete(props.row.id);
        }
      }}
      onClick={(event) =>
        props.onSelect(props.row.id, event.ctrlKey || event.metaKey)
      }
    >
      <span class="annotation-title">{title()}</span>
      <select
        class="annotation-label"
        aria-label={t("properties.label")}
        value={props.row.label_id ?? ""}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) =>
          props.onLabel(props.row.id, event.currentTarget.value || null)
        }
      >
        <option value="">{t("properties.label.none")}</option>
        <For each={props.labels}>
          {(label) => <option value={label.id}>{label.name}</option>}
        </For>
      </select>
      <button
        type="button"
        class="button"
        aria-label={t("properties.delete")}
        onClick={(event) => {
          event.stopPropagation();
          props.onDelete(props.row.id);
        }}
      >
        {t("properties.delete")}
      </button>
    </div>
  );
}
