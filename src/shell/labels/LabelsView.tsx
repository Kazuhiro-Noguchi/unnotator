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
import { filterLabels, moveLabel, nextSortOrder } from "./list";

export interface LabelsViewProps {
  data: Pick<ProjectData, "labels" | "subscribe" | "apply" | "labelUsage">;
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
  const move = (id: string, direction: "up" | "down") => {
    const changes = moveLabel(labels(), id, direction);
    if (changes === null) return;
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
        <For each={shown()}>
          {(label) => (
            <LabelItem
              label={label}
              canMove={query().trim() === ""}
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
  onEdit: () => void;
  onToggleHidden: () => void;
  onMove: (direction: "up" | "down") => void;
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
      classList={{ hidden: props.label.hidden }}
      data-label-id={props.label.id}
    >
      <div class="label-head">
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
          <Show when={props.canMove}>
            {iconButton("$(chevron-up)", t("labels.moveUp"), () =>
              props.onMove("up"),
            )}
            {iconButton("$(chevron-down)", t("labels.moveDown"), () =>
              props.onMove("down"),
            )}
          </Show>
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
