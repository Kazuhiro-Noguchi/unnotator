import { Match, Show, Switch } from "solid-js";
import { format } from "../../i18n";
import { Icon } from "../Icon";
import { useT } from "../solid";
import type { TreeRow as Row } from "./types";

/** 1 行の高さ（CSS の px）。仮想スクロールの計算と、CSS の変数 `--tree-row-height` の元。 */
export const ROW_HEIGHT = 28;

export interface TreeRowProps {
  row: Row;
  index: number;
  focused: boolean;
  selected: boolean;
  onActivate: () => void;
  onToggle: () => void;
}

export function TreeRowView(props: TreeRowProps) {
  const t = useT();
  const label = (row: Row) => {
    if (row.kind === "root") {
      return row.name === "" ? t("explorer.root.project") : row.name;
    }
    return "name" in row ? row.name : "";
  };
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: フォーカスはツリー全体が持ち、aria-activedescendant で行を示す
    // biome-ignore lint/a11y/useKeyWithClickEvents: キー操作はツリー全体（Explorer.tsx）が受ける
    <div
      id={`explorer-row-${props.index}`}
      class="tree-row"
      classList={{
        focused: props.focused,
        selected: props.selected,
        missing: props.row.kind === "asset" && props.row.missing,
      }}
      role="treeitem"
      aria-level={("depth" in props.row ? props.row.depth : 0) + 1}
      aria-selected={props.selected}
      aria-expanded={
        props.row.kind === "root" || props.row.kind === "folder"
          ? props.row.expanded
          : undefined
      }
      style={{
        top: `${props.index * ROW_HEIGHT}px`,
        height: `${ROW_HEIGHT}px`,
        "--tree-depth": "depth" in props.row ? props.row.depth : 0,
      }}
      onClick={() => props.onActivate()}
    >
      <Switch>
        <Match when={props.row.kind === "root" || props.row.kind === "folder"}>
          <button
            type="button"
            class="tree-chevron"
            tabIndex={-1}
            aria-hidden="true"
            onClick={(event) => {
              event.stopPropagation();
              props.onToggle();
            }}
          >
            <Icon
              name={
                (props.row as { expanded: boolean }).expanded
                  ? "$(chevron-down)"
                  : "$(chevron-right)"
              }
              size={16}
            />
          </button>
          <Icon name="$(folder)" size={16} />
          <span class="tree-name">{label(props.row)}</span>
          <Show when={props.row.kind === "root" || props.row.kind === "folder"}>
            <span class="tree-count">
              {format(t("explorer.count"), {
                done: (props.row as { done: number }).done,
                total: (props.row as { total: number }).total,
              })}
            </span>
          </Show>
        </Match>
        <Match when={props.row.kind === "asset"}>
          <span class="tree-chevron-space" />
          <Icon
            name={
              (props.row as { media_type: string | null }).media_type
                ? "$(file)"
                : "$(unknown)"
            }
            size={16}
          />
          <span class="tree-name">{label(props.row)}</span>
          <Show when={(props.row as { missing: boolean }).missing}>
            <span class="tree-missing">{t("explorer.missing")}</span>
          </Show>
          <span
            class="status-dot"
            role="img"
            data-status={(props.row as { status: string }).status}
            aria-label={t(
              `explorer.status.${(props.row as { status: "todo" | "in_progress" | "done" | "review" }).status}`,
            )}
            title={t(
              `explorer.status.${(props.row as { status: "todo" | "in_progress" | "done" | "review" }).status}`,
            )}
          />
        </Match>
        <Match when={true}>
          <span class="tree-chevron-space" />
          <span class="tree-name tree-loading">{t("explorer.loading")}</span>
        </Match>
      </Switch>
    </div>
  );
}
