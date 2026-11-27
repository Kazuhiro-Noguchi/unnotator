import { For, Show } from "solid-js";
import type {
  AnnotationRow,
  Command,
  GroupRow,
  LabelRow,
  RelationRow,
  SchemaRow,
} from "../project-data/types";
import { AttributeForm } from "../schema/AttributeForm";
import { type Attributes, parseAttributes } from "../schema/attributes";
import { deriveForm } from "../schema/derive-form";
import { useT } from "../solid";

export interface LinksProps {
  relations: readonly RelationRow[];
  groups: readonly GroupRow[];
  rows: readonly AnnotationRow[];
  labels: readonly LabelRow[];
  schemas: readonly SchemaRow[];
  selected: ReadonlySet<string>;
  /** 関係・グループの編集。 */
  run: (command: Command) => void;
  onCreateRelation: () => void;
  onCreateGroup: () => void;
  onAddToGroup: (groupId: string) => void;
  onMove: (group: GroupRow, annotationId: string, dir: "up" | "down") => void;
}

/** 関係とグループ。作成・ラベル・属性・メンバーの編集・削除。 */
export function Links(props: LinksProps) {
  const t = useT();
  const nameOf = (id: string) => {
    const row = props.rows.find((r) => r.id === id);
    return row === undefined ? id : row.summary || row.type;
  };
  const labelSelect = (
    current: string | null,
    onChange: (labelId: string | null) => void,
  ) => (
    <select
      aria-label={t("properties.label")}
      value={current ?? ""}
      onChange={(event) => onChange(event.currentTarget.value || null)}
    >
      <option value="">{t("properties.label.none")}</option>
      <For each={props.labels}>
        {(label) => <option value={label.id}>{label.name}</option>}
      </For>
    </select>
  );
  const labelField = (labelId: string | null) =>
    labelId === null
      ? ({ kind: "clear" } as const)
      : ({ kind: "set", value: labelId } as const);

  return (
    <>
      <section class="prop-section">
        <h3>{t("properties.section.relations")}</h3>
        <div class="form-actions">
          <button
            type="button"
            class="button"
            disabled={props.selected.size !== 2}
            title={t("relations.needTwo")}
            onClick={props.onCreateRelation}
          >
            {t("relations.create")}
          </button>
        </div>
        <Show
          when={props.relations.length > 0}
          fallback={<p class="prop-empty">{t("relations.none")}</p>}
        >
          <ul class="link-list">
            <For each={props.relations}>
              {(relation) => (
                <li class="link-item">
                  <span class="link-title">
                    {nameOf(relation.from_id)} {t("relations.arrow")}{" "}
                    {nameOf(relation.to_id)}
                  </span>
                  {labelSelect(relation.label_id, (labelId) =>
                    props.run({
                      kind: "update_relation",
                      id: relation.id,
                      patch: { label_id: labelField(labelId) },
                    }),
                  )}
                  <label class="field label-hidden-field">
                    <input
                      type="checkbox"
                      checked={relation.directed}
                      onChange={(event) =>
                        props.run({
                          kind: "update_relation",
                          id: relation.id,
                          patch: {
                            directed: {
                              kind: "set",
                              value: event.currentTarget.checked,
                            },
                          },
                        })
                      }
                    />
                    <span>{t("relations.directed")}</span>
                  </label>
                  <button
                    type="button"
                    class="button"
                    onClick={() =>
                      props.run({ kind: "delete_relation", id: relation.id })
                    }
                  >
                    {t("properties.delete")}
                  </button>
                  <LinkAttributes
                    fields={deriveForm(props.schemas, {
                      kind: "relation",
                      type: relation.type,
                      labelId: relation.label_id,
                    })}
                    json={relation.attributes_json}
                    onCommit={(next) =>
                      props.run({
                        kind: "update_relation",
                        id: relation.id,
                        patch: {
                          attributes_json: {
                            kind: "set",
                            value: JSON.stringify(next),
                          },
                        },
                      })
                    }
                  />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section class="prop-section">
        <h3>{t("properties.section.groups")}</h3>
        <div class="form-actions">
          <button
            type="button"
            class="button"
            disabled={props.selected.size === 0}
            title={t("groups.needSome")}
            onClick={props.onCreateGroup}
          >
            {t("groups.create")}
          </button>
        </div>
        <Show
          when={props.groups.length > 0}
          fallback={<p class="prop-empty">{t("groups.none")}</p>}
        >
          <ul class="link-list">
            <For each={props.groups}>
              {(group) => (
                <li class="link-item">
                  <span class="link-title">{t("groups.members")}</span>
                  {labelSelect(group.label_id, (labelId) =>
                    props.run({
                      kind: "update_group",
                      id: group.id,
                      patch: { label_id: labelField(labelId) },
                    }),
                  )}
                  <label class="field label-hidden-field">
                    <input
                      type="checkbox"
                      checked={group.ordered}
                      onChange={(event) =>
                        props.run({
                          kind: "update_group",
                          id: group.id,
                          patch: {
                            ordered: {
                              kind: "set",
                              value: event.currentTarget.checked,
                            },
                          },
                        })
                      }
                    />
                    <span>{t("groups.ordered")}</span>
                  </label>
                  <button
                    type="button"
                    class="button"
                    disabled={props.selected.size === 0}
                    onClick={() => props.onAddToGroup(group.id)}
                  >
                    {t("groups.addMember")}
                  </button>
                  <button
                    type="button"
                    class="button"
                    onClick={() =>
                      props.run({ kind: "delete_group", id: group.id })
                    }
                  >
                    {t("properties.delete")}
                  </button>
                  <Show
                    when={group.members.length > 0}
                    fallback={<p class="prop-empty">{t("groups.empty")}</p>}
                  >
                    <ol class="member-list">
                      <For each={group.members}>
                        {(member) => (
                          <li>
                            <span>{nameOf(member)}</span>
                            <Show when={group.ordered}>
                              <button
                                type="button"
                                class="button"
                                aria-label={t("labels.moveUp")}
                                onClick={() =>
                                  props.onMove(group, member, "up")
                                }
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                class="button"
                                aria-label={t("labels.moveDown")}
                                onClick={() =>
                                  props.onMove(group, member, "down")
                                }
                              >
                                ↓
                              </button>
                            </Show>
                            <button
                              type="button"
                              class="button"
                              aria-label={t("groups.removeMember")}
                              title={t("groups.removeMember")}
                              onClick={() =>
                                props.run({
                                  kind: "remove_group_members",
                                  group_id: group.id,
                                  annotation_ids: [member],
                                })
                              }
                            >
                              ×
                            </button>
                          </li>
                        )}
                      </For>
                    </ol>
                  </Show>
                  <LinkAttributes
                    fields={deriveForm(props.schemas, {
                      kind: "group",
                      type: group.type,
                      labelId: group.label_id,
                    })}
                    json={group.attributes_json}
                    onCommit={(next) =>
                      props.run({
                        kind: "update_group",
                        id: group.id,
                        patch: {
                          attributes_json: {
                            kind: "set",
                            value: JSON.stringify(next),
                          },
                        },
                      })
                    }
                  />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </>
  );
}

function LinkAttributes(props: {
  fields: ReturnType<typeof deriveForm>;
  json: string;
  onCommit: (next: Attributes) => void;
}) {
  return (
    <Show when={props.fields.length > 0}>
      <AttributeForm
        fields={props.fields}
        attributes={parseAttributes(props.json)}
        onCommit={props.onCommit}
      />
    </Show>
  );
}
