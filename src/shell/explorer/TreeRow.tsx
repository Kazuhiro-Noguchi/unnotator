import { Match, Show, Switch } from "solid-js";
import { format } from "../../i18n";
import { Icon } from "../Icon";
import { useT } from "../solid";
import type { AssetItemsState, ItemCell } from "./items";
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
  /** アセットの行で、アイテムを展開できるか。 */
  canExpand?: boolean;
  /** アイテムの行の中身。 */
  itemCell?: ItemCell | undefined;
  /** アイテムを展開したアセットの、取得の状態（読み込み中の行に使う）。 */
  itemsState?: AssetItemsState | undefined;
  onRetry?: () => void;
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
          : props.row.kind === "asset" && props.canExpand
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
          <Show
            when={props.canExpand}
            fallback={<span class="tree-chevron-space" />}
          >
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
          </Show>
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
        <Match when={props.row.kind === "item_slot"}>
          <ItemCellView
            cell={props.itemCell}
            onRetry={() => props.onRetry?.()}
          />
        </Match>
        <Match when={true}>
          <span class="tree-chevron-space" />
          <AssetItemsStatus
            state={props.itemsState}
            onRetry={() => props.onRetry?.()}
          />
        </Match>
      </Switch>
    </div>
  );
}

function ErrorLine(props: { text: string; onRetry: () => void }) {
  const t = useT();
  return (
    <>
      <span class="tree-name tree-error">{props.text}</span>
      <button
        type="button"
        class="button"
        data-item-retry
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
          props.onRetry();
        }}
      >
        {t("explorer.item.retry")}
      </button>
    </>
  );
}

/** アイテム 1 件の行。 */
function ItemCellView(props: {
  cell: ItemCell | undefined;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <>
      <span class="tree-chevron-space" />
      <Switch>
        <Match when={props.cell?.kind === "item"}>
          <Icon name="$(file)" size={16} />
          <span class="tree-name">
            {(props.cell as { info: { title: string } }).info.title}
          </span>
          <span
            class="status-dot"
            role="img"
            data-status={(props.cell as { status: string }).status}
            aria-label={t(
              `explorer.status.${(props.cell as { status: "todo" | "in_progress" | "done" | "review" }).status}`,
            )}
          />
        </Match>
        <Match when={props.cell?.kind === "error"}>
          <ErrorLine
            text={t(
              (props.cell as { error: string }).error === "timeout"
                ? "explorer.item.error.timeout"
                : "explorer.item.error.failed",
            )}
            onRetry={props.onRetry}
          />
        </Match>
        <Match when={true}>
          <span class="tree-name tree-loading">{t("explorer.loading")}</span>
        </Match>
      </Switch>
    </>
  );
}

/** アセットのアイテムの数がまだ分からないあいだの行（読み込み中・エラー・未対応）。 */
function AssetItemsStatus(props: {
  state: AssetItemsState | undefined;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <Switch>
      <Match when={props.state?.kind === "error"}>
        <ErrorLine
          text={t(
            (props.state as { error: string }).error === "timeout"
              ? "explorer.item.error.timeout"
              : "explorer.item.error.failed",
          )}
          onRetry={props.onRetry}
        />
      </Match>
      <Match when={props.state?.kind === "unsupported"}>
        <span class="tree-name tree-loading">
          {t("explorer.item.unsupported")}
        </span>
      </Match>
      <Match when={true}>
        <span class="tree-name tree-loading">{t("explorer.loading")}</span>
      </Match>
    </Switch>
  );
}
