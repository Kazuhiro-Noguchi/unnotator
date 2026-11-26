import { createSignal, For, onCleanup } from "solid-js";
import type { Status } from "../../ipc";
import { useT } from "../solid";
import {
  clearFilter,
  isEmptyFilter,
  setMissing,
  setName,
  toggleMedia,
  toggleStatus,
} from "./filter";
import type { TreeFilter } from "./types";

const STATUSES: Status[] = ["todo", "in_progress", "done", "review"];

export interface FilterBarProps {
  filter: TreeFilter;
  onChange: (filter: TreeFilter) => void;
  /** 選べる媒体種別の ID（「不明」は常に選べる）。 */
  mediaTypes: readonly string[];
  /** 名前の入力をまとめる待ち時間（ミリ秒）。 */
  debounceMs: number;
}

export function FilterBar(props: FilterBarProps) {
  const t = useT();
  const [text, setText] = createSignal(props.filter.name ?? "");
  let timer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => {
    if (timer !== null) clearTimeout(timer);
  });

  const onName = (value: string) => {
    setText(value);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      props.onChange(setName(props.filter, value));
    }, props.debounceMs);
  };

  const missingValue = () => {
    const missing = props.filter.missing;
    return missing === null ? "any" : missing ? "only" : "without";
  };

  return (
    <search class="filter-bar" aria-label={t("explorer.filter.label")}>
      <div class="filter-row">
        <input
          type="search"
          class="filter-name"
          placeholder={t("explorer.filter.name")}
          aria-label={t("explorer.filter.name")}
          value={text()}
          onInput={(event) => onName(event.currentTarget.value)}
        />
        <button
          type="button"
          class="button"
          data-filter-clear
          disabled={isEmptyFilter(props.filter)}
          onClick={() => {
            setText("");
            props.onChange(clearFilter());
          }}
        >
          {t("explorer.filter.clear")}
        </button>
      </div>
      <fieldset class="filter-group">
        <legend>{t("explorer.filter.status")}</legend>
        <For each={STATUSES}>
          {(status) => (
            <label class="filter-chip">
              <input
                type="checkbox"
                data-filter-status={status}
                checked={props.filter.statuses.includes(status)}
                onChange={() =>
                  props.onChange(toggleStatus(props.filter, status))
                }
              />
              {t(`explorer.status.${status}`)}
            </label>
          )}
        </For>
      </fieldset>
      <fieldset class="filter-group">
        <legend>{t("explorer.filter.media")}</legend>
        <label class="filter-chip">
          <input
            type="checkbox"
            data-filter-media="unknown"
            checked={props.filter.media_types.some((m) => m.kind === "unknown")}
            onChange={() =>
              props.onChange(toggleMedia(props.filter, { kind: "unknown" }))
            }
          />
          {t("explorer.filter.unknown")}
        </label>
        <For each={[...props.mediaTypes]}>
          {(id) => (
            <label class="filter-chip">
              <input
                type="checkbox"
                data-filter-media={id}
                checked={props.filter.media_types.some(
                  (m) => m.kind === "is" && m.value === id,
                )}
                onChange={() =>
                  props.onChange(
                    toggleMedia(props.filter, { kind: "is", value: id }),
                  )
                }
              />
              {id}
            </label>
          )}
        </For>
      </fieldset>
      <label class="filter-missing">
        {t("explorer.filter.missing")}
        <select
          data-filter-missing
          value={missingValue()}
          onChange={(event) => {
            const value = event.currentTarget.value;
            props.onChange(
              setMissing(
                props.filter,
                value === "only" ? true : value === "without" ? false : null,
              ),
            );
          }}
        >
          <option value="any">{t("explorer.filter.missing.any")}</option>
          <option value="only">{t("explorer.filter.missing.only")}</option>
          <option value="without">
            {t("explorer.filter.missing.without")}
          </option>
        </select>
      </label>
    </search>
  );
}
