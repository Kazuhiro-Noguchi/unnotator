import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { format } from "../../i18n";
import { Icon } from "../Icon";
import type { ProjectData } from "../project-data/store";
import type { Command, LabelRow } from "../project-data/types";
import { fromStore, useT } from "../solid";
import type { NotifyLevel } from "../types";
import { deleteCommand } from "./delete";
import { LabelDelete } from "./LabelDelete";
import { LabelForm } from "./LabelForm";
import {
  defaultLabelColor,
  dropIndexFor,
  filterLabels,
  finalIndex,
  moveLabel,
  newLabelName,
  nextSortOrder,
  reorderLabels,
} from "./list";
import type { ClickMode } from "./selection";
import { createLabelsUi, type LabelsUi } from "./ui";

export interface LabelsViewProps {
  data: Pick<ProjectData, "labels" | "subscribe" | "apply" | "labelUsage">;
  notify: (level: NotifyLevel, text: string) => void;
  /** 見出しの操作（追加・絞り込み）と共有する状態。省略すると、この一覧だけのものを使う。 */
  ui?: LabelsUi;
  /** 選択中のラベルの ID（複数）。 */
  selectedIds?(): ReadonlySet<string>;
  /**
   * カードのクリック: ラベルを選ぶ。`toggle`（通常・Ctrl / Cmd）は選択に足す・外す、`range`（Shift）は範囲。
   * `order` は、見えているラベルの並び。分類は、付かない。
   */
  onPick?(label: LabelRow, mode: ClickMode, order: readonly string[]): void;
}

/** サイドバー「ラベル」。一覧・絞り込み・追加。 */
export function LabelsView(props: LabelsViewProps) {
  const t = useT();
  const labels = fromStore(
    () => props.data.labels(),
    (listener) => props.data.subscribe(listener),
  );
  const ui = props.ui ?? createLabelsUi();
  const query = ui.query;
  const shown = () => filterLabels(labels(), query());
  const selected = (id: string) => props.selectedIds?.().has(id) ?? false;
  /** 隣のカードの「選ぶ」ボタンへ、フォーカスを移す（↑ ↓ キー）。選択は、押したときに決まる。 */
  const focusNeighbor = (id: string, step: -1 | 1) => {
    const list = shown();
    const next = list[list.findIndex((l) => l.id === id) + step];
    if (next === undefined) return;
    listEl
      ?.querySelector<HTMLElement>(`[data-label-id="${next.id}"] .label-pick`)
      ?.focus();
  };
  const [editing, setEditing] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<string | null>(null);

  const fail = (e: unknown) =>
    props.notify(
      "error",
      format(t("labels.error.failed"), {
        reason: e instanceof Error ? e.message : String(e),
      }),
    );
  const run = async (command: Command): Promise<boolean> => {
    try {
      await props.data.apply(command);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };
  const update = async (
    label: LabelRow,
    draft: {
      name: string;
      color: string;
      hotkey: number | null;
      hidden: boolean;
    },
  ) => {
    const patch: Extract<Command, { kind: "update_label" }>["patch"] = {};
    if (draft.name !== label.name)
      patch.name = { kind: "set", value: draft.name };
    if (draft.color !== label.color) {
      patch.color = { kind: "set", value: draft.color };
    }
    if (draft.hotkey !== label.hotkey) {
      patch.hotkey =
        draft.hotkey === null
          ? { kind: "clear" }
          : { kind: "set", value: draft.hotkey };
    }
    if (draft.hidden !== label.hidden) {
      patch.hidden = { kind: "set", value: draft.hidden };
    }
    // 即時変更: 書いたあとも、編集は開いたままにする。
    if (Object.keys(patch).length === 0) return;
    await run({ kind: "update_label", id: label.id, patch });
  };
  /** 並び順を振り直す（変わるものだけ。1 つの元に戻せる操作）。 */
  const applyOrders = (
    changes: Array<{ id: string; sort_order: number }> | null,
  ) => {
    if (changes === null || changes.length === 0) return;
    const commands: Command[] = changes.map((c) => ({
      kind: "update_label",
      id: c.id,
      patch: { sort_order: { kind: "set", value: c.sort_order } },
    }));
    const [only] = commands;
    void run(
      commands.length === 1 && only !== undefined
        ? only
        : { kind: "transaction", commands },
    );
  };
  const move = (id: string, direction: "up" | "down") =>
    applyOrders(moveLabel(labels(), id, direction));

  // ドラッグで並べ替える。ポインターで動かす（WebView ごとの違いが無く、Windows でも使える）。
  const [drag, setDrag] = createSignal<{
    id: string;
    insertion: number;
  } | null>(null);
  let listEl: HTMLUListElement | undefined;
  const insertionAt = (y: number) => {
    const cards = listEl?.querySelectorAll<HTMLElement>(":scope > .label-card");
    const centers = [...(cards ?? [])].map((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    return dropIndexFor(centers, y);
  };
  const dragStart = (id: string) =>
    setDrag({
      id,
      insertion: labels().findIndex((l) => l.id === id),
    });
  const dragMove = (y: number) =>
    setDrag((current) =>
      current === null ? null : { ...current, insertion: insertionAt(y) },
    );
  const dragEnd = (commit: boolean) => {
    const current = drag();
    setDrag(null);
    if (!commit || current === null) return;
    const from = labels().findIndex((l) => l.id === current.id);
    applyOrders(
      reorderLabels(labels(), current.id, finalIndex(from, current.insertion)),
    );
  };

  /** 見出しの「追加」: すぐに、名前を仮に付けたラベルを作り、その編集を開く（名前をすぐ打てる）。 */
  const createNew = async () => {
    try {
      const set = await props.data.apply({
        kind: "create_label",
        name: newLabelName(labels(), t("labels.newName")),
        color: defaultLabelColor(labels().length),
        sort_order: nextSortOrder(labels()),
      });
      const created = set.changes.find(
        (c) => c.entity === "label" && c.kind === "created",
      );
      if (created !== undefined) {
        setDeleting(null);
        setEditing(created.id);
      }
    } catch (e) {
      fail(e);
    }
  };
  ui.setCreateHandler(() => void createNew());
  onCleanup(() => ui.setCreateHandler(null));

  /** ドラッグ中、挿入位置の目印を出すカード（その前、または、最後のカードの後ろ）。 */
  const dropMarkFor = (id: string): "before" | "end" | null => {
    const current = drag();
    if (current === null) return null;
    const index = labels().findIndex((l) => l.id === id);
    const from = labels().findIndex((l) => l.id === current.id);
    // 自分の直前・直後への挿入は、動かないので、目印を出さない。
    if (current.insertion === from || current.insertion === from + 1)
      return null;
    if (index === current.insertion) return "before";
    if (
      current.insertion === labels().length &&
      index === labels().length - 1
    ) {
      return "end";
    }
    return null;
  };

  return (
    <div class="labels-view">
      <Show when={ui.filterOpen()}>
        <input
          type="search"
          class="filter-name"
          placeholder={t("labels.filter")}
          aria-label={t("labels.filter")}
          value={query()}
          ref={(el) => queueMicrotask(() => el.focus())}
          onInput={(event) => ui.setQuery(event.currentTarget.value)}
        />
      </Show>
      <ul class="label-list" ref={listEl}>
        <For each={shown()}>
          {(label) => (
            <LabelItem
              label={label}
              canMove={query().trim() === ""}
              dragging={drag()?.id === label.id}
              dropMark={dropMarkFor(label.id)}
              selected={selected(label.id)}
              onSelect={(mode) =>
                props.onPick?.(
                  label,
                  mode,
                  shown().map((l) => l.id),
                )
              }
              onNavigate={(step) => focusNeighbor(label.id, step)}
              editing={editing() === label.id}
              onEdit={() => {
                setDeleting(null);
                setEditing(editing() === label.id ? null : label.id);
              }}
              onToggleHidden={() =>
                void run({
                  kind: "update_label",
                  id: label.id,
                  patch: { hidden: { kind: "set", value: !label.hidden } },
                })
              }
              onMove={(direction) => move(label.id, direction)}
              onDragStart={() => dragStart(label.id)}
              onDragMove={dragMove}
              onDragEnd={dragEnd}
            >
              <Show when={editing() === label.id}>
                <LabelForm
                  label={label}
                  labels={labels()}
                  onChange={(draft) => void update(label, draft)}
                  onClose={() => setEditing(null)}
                  onDelete={() => {
                    setEditing(null);
                    setDeleting(label.id);
                  }}
                />
              </Show>
              <Show when={deleting() === label.id}>
                <LabelDelete
                  label={label}
                  labels={labels()}
                  loadUsage={(id) => props.data.labelUsage(id)}
                  onConfirm={async (choice) => {
                    if (await run(deleteCommand(label.id, choice))) {
                      setDeleting(null);
                    }
                  }}
                  onCancel={() => setDeleting(null)}
                />
              </Show>
            </LabelItem>
          )}
        </For>
      </ul>
      <Show when={shown().length === 0 && labels().length > 0}>
        <p class="label-empty">{t("labels.noMatch")}</p>
      </Show>
    </div>
  );
}

function LabelItem(props: {
  label: LabelRow;
  canMove: boolean;
  /** 選択中か（カードをクリックして選ぶ）。 */
  selected: boolean;
  onSelect: (mode: ClickMode) => void;
  /** ↑ ↓ キーで、隣のカードを選ぶ。 */
  onNavigate: (step: -1 | 1) => void;
  /** 編集を開いているか（鉛筆は、開閉の切り替え）。 */
  editing: boolean;
  dragging: boolean;
  dropMark: "before" | "end" | null;
  onEdit: () => void;
  onToggleHidden: () => void;
  onMove: (direction: "up" | "down") => void;
  onDragStart: () => void;
  onDragMove: (y: number) => void;
  onDragEnd: (commit: boolean) => void;
  /** 編集・削除の確認など、カードの中に開くもの。 */
  children?: JSX.Element;
}) {
  const t = useT();
  const iconButton = (
    icon: string,
    label: string,
    onClick: () => void,
    pressed?: boolean,
  ) => (
    <button
      type="button"
      class="button icon-button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <Icon name={icon} size={16} />
    </button>
  );
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: カードのどこを押しても選べる（マウス用）。キーボードでは、中の「選ぶ」ボタンで選ぶ
    <li
      class="label-item label-card"
      aria-current={props.selected ? "true" : undefined}
      onClick={(event) => {
        // 中のボタン（鉛筆・目・つかみ）・入力欄・編集のフォームを押したときは、選ばない。
        const inner = (event.target as Element).closest(
          "button, input, select, textarea, label, .label-form, .label-delete",
        );
        if (inner !== null && !inner.classList.contains("label-pick")) return;
        // 通常のクリックも、Ctrl / Cmd も、選択に足す・外す。Shift は、範囲。
        props.onSelect(event.shiftKey ? "range" : "toggle");
      }}
      classList={{
        selected: props.selected,
        hidden: props.label.hidden,
        dragging: props.dragging,
        "drop-before": props.dropMark === "before",
        "drop-end": props.dropMark === "end",
      }}
      data-label-id={props.label.id}
    >
      <div class="label-head">
        <Show when={props.canMove}>
          <button
            type="button"
            class="label-grip"
            aria-label={t("labels.drag")}
            title={t("labels.drag")}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              props.onDragStart();
            }}
            onPointerMove={(event) => {
              if (props.dragging) props.onDragMove(event.clientY);
            }}
            onPointerUp={() => props.onDragEnd(true)}
            onPointerCancel={() => props.onDragEnd(false)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              props.onMove(event.key === "ArrowUp" ? "up" : "down");
            }}
          >
            <Icon name="$(grip)" size={16} />
          </button>
        </Show>
        <button
          type="button"
          class="label-pick"
          aria-pressed={props.selected}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              props.onNavigate(event.key === "ArrowDown" ? 1 : -1);
            }
          }}
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
        </button>
        <span class="label-actions">
          {iconButton(
            props.label.hidden ? "$(eye-off)" : "$(eye)",
            props.label.hidden ? t("labels.show") : t("labels.hide"),
            props.onToggleHidden,
            props.label.hidden,
          )}
          {iconButton(
            "$(pencil)",
            t("labels.edit"),
            props.onEdit,
            props.editing,
          )}
        </span>
      </div>
      {props.children}
    </li>
  );
}
