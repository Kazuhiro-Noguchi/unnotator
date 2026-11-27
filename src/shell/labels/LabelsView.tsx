import { createSignal, For, type JSX, Show } from "solid-js";
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
  dropIndexFor,
  filterLabels,
  finalIndex,
  moveLabel,
  nextSortOrder,
  reorderLabels,
} from "./list";
import { createLabelsUi, type LabelsUi } from "./ui";

export interface LabelsViewProps {
  data: Pick<ProjectData, "labels" | "subscribe" | "apply" | "labelUsage">;
  notify: (level: NotifyLevel, text: string) => void;
  /** 見出しの操作（追加・絞り込み）と共有する状態。省略すると、この一覧だけのものを使う。 */
  ui?: LabelsUi;
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
  const creating = ui.creating;
  const setCreating = ui.setCreating;
  const shown = () => filterLabels(labels(), query());
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
    if (Object.keys(patch).length === 0) return setEditing(null);
    if (await run({ kind: "update_label", id: label.id, patch })) {
      setEditing(null);
    }
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
      <Show when={creating()}>
        <LabelForm
          label={null}
          labels={labels()}
          onSubmit={(draft) => void create(draft)}
          onCancel={() => setCreating(false)}
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
              onEdit={() => {
                setDeleting(null);
                setEditing(label.id);
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
                  onSubmit={(draft) => void update(label, draft)}
                  onCancel={() => setEditing(null)}
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
    <li
      class="label-item label-card"
      classList={{
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
        <span
          class="label-swatch"
          style={{ background: props.label.color }}
          aria-hidden="true"
        />
        <span class="label-name">{props.label.name}</span>
        <Show when={props.label.hotkey !== null}>
          <kbd class="label-key">{props.label.hotkey}</kbd>
        </Show>
        <span class="label-actions">
          {iconButton(
            props.label.hidden ? "$(eye-off)" : "$(eye)",
            props.label.hidden ? t("labels.show") : t("labels.hide"),
            props.onToggleHidden,
            props.label.hidden,
          )}
          {iconButton("$(pencil)", t("labels.edit"), props.onEdit)}
        </span>
      </div>
      {props.children}
    </li>
  );
}
