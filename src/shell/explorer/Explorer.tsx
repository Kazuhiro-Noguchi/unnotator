import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { EmptyState } from "../layout/EmptyState";
import { useT } from "../solid";
import type { ExplorerController } from "./controller";
import type { CurrentStore } from "./current";
import { FilterBar } from "./FilterBar";
import { isEmptyFilter } from "./filter";
import type { RowsStore } from "./rows";
import { ROW_HEIGHT, TreeRowView } from "./TreeRow";
import type { TreeRow as TreeRowT } from "./types";

/** 見える範囲の前後に、余分に描く行数。 */
const OVERSCAN = 8;
/** 高さが測れないとき（まだ表示されていない）の見える行数。 */
const FALLBACK_VISIBLE = 30;

export interface ExplorerProps {
  controller: ExplorerController;
  rows: RowsStore;
  current: CurrentStore;
  /** 選べる媒体種別の ID。 */
  mediaTypes?: readonly string[];
  /** 名前の入力をまとめる待ち時間（ミリ秒）。 */
  filterDebounceMs?: number;
}

export function Explorer(props: ExplorerProps) {
  const t = useT();
  // どれかのストアが変わるたびに増やして、描画し直す。
  const [tick, setTick] = createSignal(0);
  const bump = () => setTick((n) => n + 1);
  const offs = [
    props.controller.subscribe(bump),
    props.rows.subscribe(bump),
    props.current.subscribe(bump),
  ];
  onCleanup(() => {
    for (const off of offs) off();
  });

  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(0);
  let container: HTMLDivElement | undefined;

  const total = () => {
    tick();
    return props.rows.total();
  };
  const range = () => {
    const visible = Math.ceil(
      (height() || ROW_HEIGHT * FALLBACK_VISIBLE) / ROW_HEIGHT,
    );
    const start = Math.max(0, Math.floor(scrollTop() / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(
      total(),
      Math.floor(scrollTop() / ROW_HEIGHT) + visible + OVERSCAN,
    );
    return { start, end };
  };
  const indexes = () => {
    const { start, end } = range();
    return Array.from(
      { length: Math.max(0, end - start) },
      (_, i) => start + i,
    );
  };

  // 範囲が変わったら、足りない行を取る。
  createEffect(() => {
    const { start, end } = range();
    void props.controller.setViewport(start, end);
  });

  // フォーカスの行が見える位置へ。
  createEffect(() => {
    tick();
    const { focus } = props.controller.snapshot();
    if (!container) return;
    const top = focus * ROW_HEIGHT;
    const view = container.clientHeight || ROW_HEIGHT * FALLBACK_VISIBLE;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (top + ROW_HEIGHT > container.scrollTop + view)
      container.scrollTop = top + ROW_HEIGHT - view;
  });

  const assetIdOf = (row: TreeRowT): string =>
    row.kind === "item_slot" || row.kind === "item_loading"
      ? row.asset_id
      : row.kind === "asset"
        ? row.id
        : "";
  const itemCellOf = (row: TreeRowT) => {
    tick();
    return row.kind === "item_slot"
      ? props.controller.items?.cell(row.asset_id, row.index)
      : undefined;
  };
  const itemsStateOf = (row: TreeRowT) => {
    tick();
    return row.kind === "item_loading"
      ? props.controller.items?.state(row.asset_id)
      : undefined;
  };

  const focusIndex = () => {
    tick();
    return props.controller.snapshot().focus;
  };

  const selectedId = () => {
    tick();
    const current = props.current.get();
    return current && current.itemKey === null ? current.assetId : null;
  };

  const filter = () => {
    tick();
    return props.controller.snapshot().filter;
  };

  return (
    <div class="explorer">
      <FilterBar
        filter={filter()}
        onChange={(next) => void props.controller.setFilter(next)}
        mediaTypes={props.mediaTypes ?? []}
        debounceMs={props.filterDebounceMs ?? 200}
      />
      <Show
        when={total() > 0}
        fallback={
          <EmptyState
            message={
              isEmptyFilter(filter())
                ? t("explorer.empty.noAssets")
                : t("explorer.empty.noMatch")
            }
            action={
              isEmptyFilter(filter())
                ? undefined
                : {
                    label: t("explorer.empty.clear"),
                    run: () =>
                      void props.controller.setFilter({
                        name: null,
                        statuses: [],
                        media_types: [],
                        missing: null,
                      }),
                  }
            }
          />
        }
      >
        <div
          class="tree"
          role="tree"
          tabIndex={0}
          aria-label={t("explorer.tree.label")}
          aria-activedescendant={`explorer-row-${focusIndex()}`}
          style={{ "--tree-row-height": `${ROW_HEIGHT}px` }}
          ref={(element) => {
            container = element;
            queueMicrotask(() => setHeight(element.clientHeight));
            // 領域の大きさが変わったら（ウィンドウ・スプリッター）、描く行数を取り直す。
            if (typeof ResizeObserver !== "undefined") {
              const observer = new ResizeObserver(() =>
                setHeight(element.clientHeight),
              );
              observer.observe(element);
              onCleanup(() => observer.disconnect());
            }
          }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          onKeyDown={(event) => {
            if (props.controller.key(event)) event.preventDefault();
          }}
        >
          <div
            class="tree-body"
            style={{ height: `${total() * ROW_HEIGHT}px` }}
          >
            <For each={indexes()}>
              {(index) => {
                const row = () => {
                  tick();
                  return props.rows.rowAt(index);
                };
                return (
                  <Show when={row()}>
                    {(value) => (
                      <TreeRowView
                        row={value()}
                        index={index}
                        canExpand={props.controller.canExpand(value())}
                        itemCell={itemCellOf(value())}
                        itemsState={itemsStateOf(value())}
                        onRetry={() =>
                          void props.controller.retryItems(assetIdOf(value()))
                        }
                        focused={focusIndex() === index}
                        selected={
                          value().kind === "asset" &&
                          (value() as { id: string }).id === selectedId()
                        }
                        onActivate={() => void props.controller.activate(index)}
                        onToggle={() => void props.controller.toggle(value())}
                      />
                    )}
                  </Show>
                );
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
