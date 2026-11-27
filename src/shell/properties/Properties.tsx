import { createEffect, createSignal, For, on, Show } from "solid-js";
import { format } from "../../i18n";
import type { Status } from "../../ipc";
import type { CurrentTarget } from "../explorer/types";
import type { ProjectData } from "../project-data/store";
import type { AnnotationRow, Command, LabelRow } from "../project-data/types";
import { AttributeForm } from "../schema/AttributeForm";
import { type Attributes, parseAttributes } from "../schema/attributes";
import { deriveForm } from "../schema/derive-form";
import { fromStore, useT } from "../solid";
import type { NotifyLevel } from "../types";
import { AnnotationList } from "./AnnotationList";
import { type DraftStore, targetKeyOf } from "./draft";
import { draftCommands } from "./draft-commit";
import { Links } from "./Links";
import { loadAllPages } from "./paging";
import {
  addToGroup,
  createGroup,
  createRelation,
  moveMember,
} from "./relations";
import type { Selection } from "./selection";

const STATUSES: Status[] = ["todo", "in_progress", "done", "review"];

export interface PropertiesProps {
  data: Pick<
    ProjectData,
    | "labels"
    | "schemas"
    | "details"
    | "error"
    | "subscribe"
    | "apply"
    | "annotationsPage"
  >;
  current: {
    get(): CurrentTarget | null;
    subscribe(listener: () => void): () => void;
  };
  drafts: DraftStore;
  selection: Selection;
  supported(): ReadonlySet<string>;
  /** 選択中のラベル（複数）。分類の付け外しのボタンに使う。 */
  selectedLabels?(): readonly LabelRow[];
  /** 選択中のラベルを、現在位置の分類として付ける・外す。 */
  onClassify?(): void;
  notify: (level: NotifyLevel, text: string) => void;
}

/** プロパティパネル（`info` ビュー）。現在位置のアセット（アイテム）の情報と、アノテーションの一覧。 */
export function Properties(props: PropertiesProps) {
  const t = useT();
  const details = fromStore(
    () => props.data.details(),
    (l) => props.data.subscribe(l),
  );
  const labels = fromStore(
    () => props.data.labels(),
    (l) => props.data.subscribe(l),
  );
  const schemas = fromStore(
    () => props.data.schemas(),
    (l) => props.data.subscribe(l),
  );
  const error = fromStore(
    () => props.data.error(),
    (l) => props.data.subscribe(l),
  );
  const current = fromStore(
    () => props.current.get(),
    (l) => props.current.subscribe(l),
  );
  const selected = fromStore(
    () => props.selection.ids(),
    (l) => props.selection.subscribe(l),
  );
  const pending = fromStore(
    () => props.drafts.pending(),
    (l) => props.drafts.subscribe(l),
  );
  const draftNote = fromStore(
    () => props.drafts.valueOf("note"),
    (l) => props.drafts.subscribe(l),
  );
  const [rows, setRows] = createSignal<readonly AnnotationRow[]>([]);

  const fail = (e: unknown) =>
    props.notify(
      "error",
      format(t("properties.saveFailed"), {
        reason: e instanceof Error ? e.message : String(e),
      }),
    );
  const run = async (command: Command) => {
    try {
      await props.data.apply(command);
    } catch (e) {
      fail(e);
    }
  };

  // 現在位置が変わったら、下書きを切り替える（残っていれば保留にする）。
  createEffect(
    on(current, (target) => {
      props.drafts.switchTo(
        target === null ? "" : targetKeyOf(target.assetId, target.itemKey),
      );
      props.selection.clear();
    }),
  );

  // 詳細が読み直されるたびに、アノテーションの一覧を読み直す（古い読み込みは捨てる）。
  let token = 0;
  createEffect(
    on(details, (d) => {
      const mine = ++token;
      if (d === null) return setRows([]);
      loadAllPages(
        (cursor) => props.data.annotationsPage(cursor),
        () => mine === token,
      )
        .then((loaded) => {
          if (loaded === null) return;
          setRows(loaded);
          props.selection.retain(new Set(loaded.map((r) => r.id)));
        })
        .catch(fail);
    }),
  );

  /** 分類のボタンの文字: 選んでいなければ案内、すべて付いていれば「外す」、付いていないものがあれば「付ける」。 */
  const classifyText = (
    selected: readonly LabelRow[],
    attachedIds: ReadonlySet<string>,
  ): string => {
    const [first] = selected;
    if (first === undefined) return t("labels.classify.select");
    const allAttached = selected.every((l) => attachedIds.has(l.id));
    if (selected.length === 1) {
      return format(
        t(allAttached ? "labels.classify.detach" : "labels.classify.attach"),
        { name: first.name },
      );
    }
    return format(
      t(
        allAttached
          ? "labels.classify.detachMany"
          : "labels.classify.attachMany",
      ),
      { count: String(selected.length) },
    );
  };

  const labelName = (id: string | null) =>
    labels().find((l) => l.id === id)?.name ?? t("properties.label.none");

  const setStatus = (status: Status) => {
    const d = details();
    if (d === null) return;
    if (d.item) {
      return run({
        kind: "set_item_status",
        item: {
          asset_id: d.asset.id,
          item_key: d.item.item_key,
          provider: d.item.provider,
        },
        status,
      });
    }
    return run({ kind: "set_asset_status", asset_id: d.asset.id, status });
  };

  const commitNote = () => {
    const d = details();
    const value = props.drafts.valueOf("note");
    if (d === null || value === undefined) return;
    void run({
      kind: "set_asset_note",
      asset_id: d.asset.id,
      note: value === "" ? null : value,
    }).then(() => props.drafts.committed("note"));
  };

  const assetFields = () => {
    const d = details();
    if (d === null) return [];
    return deriveForm(
      schemas(),
      d.item
        ? { kind: "item", provider: d.item.provider }
        : { kind: "asset", mediaType: d.asset.media_type },
    );
  };
  const assetAttributes = (): Attributes => {
    const d = details();
    return d === null
      ? {}
      : parseAttributes((d.item ?? d.asset).attributes_json);
  };
  const commitAssetAttributes = (next: Attributes) => {
    const d = details();
    if (d === null) return;
    const attributes_json = JSON.stringify(next);
    void run(
      d.item
        ? {
            kind: "set_item_attributes",
            item: {
              asset_id: d.asset.id,
              item_key: d.item.item_key,
              provider: d.item.provider,
            },
            attributes_json,
          }
        : {
            kind: "set_asset_attributes",
            asset_id: d.asset.id,
            attributes_json,
          },
    );
  };
  /** 選んでいるアノテーションが 1 つのとき、その属性フォーム。 */
  const chosen = () => {
    const ids = selected();
    if (ids.size !== 1) return null;
    return rows().find((r) => ids.has(r.id)) ?? null;
  };
  const chosenFields = () => {
    const row = chosen();
    return row === null
      ? []
      : deriveForm(schemas(), {
          kind: "annotation",
          type: row.type,
          labelId: row.label_id,
        });
  };
  const commitChosen = (next: Attributes) => {
    const row = chosen();
    if (row === null) return;
    void run({
      kind: "update_annotation",
      id: row.id,
      patch: {
        attributes_json: { kind: "set", value: JSON.stringify(next) },
      },
    });
  };

  const link = (result: ReturnType<typeof createRelation>) => {
    if (result.kind === "apply") return void run(result.command);
    props.notify(
      "error",
      t(
        result.reason === "needTwo"
          ? "relations.needTwo"
          : result.reason === "self"
            ? "relations.self"
            : "groups.needSome",
      ),
    );
  };

  const resolve = (choice: "apply" | "discard") => {
    const draft = props.drafts.resolvePending(choice);
    if (draft !== null) for (const c of draftCommands(draft)) void run(c);
  };

  return (
    <div class="properties">
      <Show when={pending()}>
        <div class="draft-banner" role="alert">
          <span>{t("properties.draft.title")}</span>
          <button
            type="button"
            class="button primary"
            onClick={() => resolve("apply")}
          >
            {t("properties.draft.apply")}
          </button>
          <button
            type="button"
            class="button"
            onClick={() => resolve("discard")}
          >
            {t("properties.draft.discard")}
          </button>
        </div>
      </Show>
      <Show
        when={current() !== null}
        fallback={<p class="prop-empty">{t("properties.noCurrent")}</p>}
      >
        <Show
          when={details()}
          fallback={
            <p class="prop-empty">
              {error() === null
                ? ""
                : format(t("properties.loadFailed"), { reason: error() ?? "" })}
            </p>
          }
        >
          {(d) => (
            <>
              <section class="prop-section">
                <h3>{t("properties.section.asset")}</h3>
                <dl class="prop-grid">
                  <dt>{t("properties.path")}</dt>
                  <dd>{d().asset.rel_path}</dd>
                  <dt>{t("properties.mediaType")}</dt>
                  <dd>
                    {d().asset.media_type ?? t("preview.info.unknownType")}
                  </dd>
                  <Show when={d().asset.missing}>
                    <dt />
                    <dd class="prop-missing">{t("properties.missing")}</dd>
                  </Show>
                  <dt>{t("properties.status")}</dt>
                  <dd>
                    <select
                      aria-label={t("properties.status")}
                      value={(d().item ?? d().asset).status}
                      disabled={current()?.itemKey != null && d().item === null}
                      onChange={(event) =>
                        void setStatus(event.currentTarget.value as Status)
                      }
                    >
                      <For each={STATUSES}>
                        {(s) => (
                          <option value={s}>{t(`explorer.status.${s}`)}</option>
                        )}
                      </For>
                    </select>
                  </dd>
                </dl>
                <Show when={current()?.itemKey === null}>
                  <label class="field">
                    <span>{t("properties.note")}</span>
                    <textarea
                      rows="3"
                      value={draftNote() ?? d().asset.note ?? ""}
                      onInput={(event) =>
                        props.drafts.edit(
                          "note",
                          d().asset.note ?? "",
                          event.currentTarget.value,
                        )
                      }
                      onBlur={commitNote}
                    />
                  </label>
                </Show>
              </section>
              <Show when={assetFields().length > 0}>
                <section class="prop-section">
                  <h3>{t("properties.section.attributes")}</h3>
                  <AttributeForm
                    fields={assetFields()}
                    attributes={assetAttributes()}
                    onCommit={commitAssetAttributes}
                  />
                </section>
              </Show>
              <section class="prop-section">
                <h3>{t("properties.classification")}</h3>
                <Show when={props.onClassify}>
                  {(classify) => (
                    <button
                      type="button"
                      class="button classify-button"
                      disabled={(props.selectedLabels?.() ?? []).length === 0}
                      title={t("labels.classify.select")}
                      onClick={() => classify()()}
                    >
                      {classifyText(
                        props.selectedLabels?.() ?? [],
                        new Set(
                          d().classification.flatMap((c) =>
                            c.label_id === null ? [] : [c.label_id],
                          ),
                        ),
                      )}
                    </button>
                  )}
                </Show>
                <Show
                  when={d().classification.length > 0}
                  fallback={
                    <p class="prop-empty">{t("properties.label.none")}</p>
                  }
                >
                  <ul class="prop-chips">
                    <For each={d().classification}>
                      {(c) => <li>{labelName(c.label_id)}</li>}
                    </For>
                  </ul>
                </Show>
              </section>
              <section class="prop-section">
                <h3>
                  {t("properties.section.annotations")}{" "}
                  <span class="prop-count">
                    {format(t("properties.annotations.count"), {
                      count: String(d().annotation_count),
                    })}
                  </span>
                </h3>
                <AnnotationList
                  rows={rows()}
                  labels={labels()}
                  supported={props.supported()}
                  selected={selected()}
                  onSelect={(id, multi) => props.selection.select(id, multi)}
                  onLabel={(id, labelId) =>
                    void run({
                      kind: "update_annotation",
                      id,
                      patch: {
                        label_id:
                          labelId === null
                            ? { kind: "clear" }
                            : { kind: "set", value: labelId },
                      },
                    })
                  }
                  onDelete={(id) => void run({ kind: "delete_annotation", id })}
                />
                <Show when={chosen() !== null && chosenFields().length > 0}>
                  <AttributeForm
                    fields={chosenFields()}
                    attributes={parseAttributes(
                      chosen()?.attributes_json ?? "{}",
                    )}
                    onCommit={commitChosen}
                  />
                </Show>
              </section>
              <Links
                relations={d().relations}
                groups={d().groups}
                rows={rows()}
                labels={labels()}
                schemas={schemas()}
                selected={selected()}
                run={(command) => void run(command)}
                onCreateRelation={() => link(createRelation([...selected()]))}
                onCreateGroup={() => link(createGroup([...selected()]))}
                onAddToGroup={(groupId) =>
                  link(
                    addToGroup(
                      groupId,
                      [...selected()],
                      d().groups.find((g) => g.id === groupId)?.members ?? [],
                    ),
                  )
                }
                onMove={(group, annotationId, dir) => {
                  const command = moveMember(group, annotationId, dir);
                  if (command !== null) void run(command);
                }}
              />
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}
