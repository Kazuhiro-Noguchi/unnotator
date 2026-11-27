import { createMemo, createSignal, For, Show } from "solid-js";
import { format, type MessageKey } from "../../i18n";
import type { ProjectData } from "../project-data/store";
import type { AttributeScope } from "../project-data/types";
import { fromStore, useT } from "../solid";
import type { NotifyLevel } from "../types";
import { affectedNames, assess } from "./impact";
import {
  blankProperty,
  type EditorProperty,
  fromSchemaJson,
  toSchemaJson,
  validateProperties,
} from "./schema-edit";

const SCOPES: AttributeScope[] = [
  "global",
  "label",
  "annotation_type",
  "relation_type",
  "group_type",
  "asset",
  "item",
];
const KINDS = ["string", "number", "integer", "boolean", "enum"] as const;

export interface SchemaEditorProps {
  data: Pick<
    ProjectData,
    "labels" | "schemas" | "subscribe" | "apply" | "attributeUsage"
  >;
  notify: (level: NotifyLevel, text: string) => void;
}

/** 属性スキーマの編集画面。対象（scope + target）ごとに、属性を定義する。 */
export function SchemaEditor(props: SchemaEditorProps) {
  const t = useT();
  const labels = fromStore(
    () => props.data.labels(),
    (l) => props.data.subscribe(l),
  );
  const schemas = fromStore(
    () => props.data.schemas(),
    (l) => props.data.subscribe(l),
  );
  const [scope, setScope] = createSignal<AttributeScope>("global");
  const [target, setTarget] = createSignal("");
  const [items, setItems] = createSignal<EditorProperty[]>([]);
  const [loadedKey, setLoadedKey] = createSignal("");
  const [pendingCount, setPendingCount] = createSignal<number | null>(null);
  const [errors, setErrors] = createSignal<
    ReturnType<typeof validateProperties>
  >([]);

  const key = () => `${scope()}\u0000${target()}`;
  const stored = createMemo(
    () =>
      schemas().find((s) => s.scope === scope() && s.target === target())
        ?.schema_json ?? null,
  );
  // 対象を切り替えたら、保存済みの内容を読み込む。
  const sync = () => {
    if (loadedKey() === key()) return;
    setLoadedKey(key());
    setItems(fromSchemaJson(stored()));
    setPendingCount(null);
    setErrors([]);
  };

  const update = (index: number, patch: Partial<EditorProperty>) =>
    setItems((list) =>
      list.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );

  const fail = (e: unknown) =>
    props.notify(
      "error",
      format(t("properties.saveFailed"), {
        reason: e instanceof Error ? e.message : String(e),
      }),
    );

  const write = async (command: Parameters<ProjectData["apply"]>[0]) => {
    try {
      await props.data.apply(command);
      setPendingCount(null);
    } catch (e) {
      fail(e);
    }
  };

  /** 影響する件数を調べ、0 件なら書き込み、1 件以上なら確認を挟む。 */
  const submit = async (next: string | null) => {
    const names = affectedNames(stored(), next);
    let count = 0;
    try {
      count =
        names.length === 0
          ? 0
          : await props.data.attributeUsage(scope(), target(), names);
    } catch (e) {
      return fail(e);
    }
    const verdict = assess(count);
    if (verdict.kind === "confirm" && pendingCount() === null) {
      return setPendingCount(verdict.count);
    }
    await write(
      next === null
        ? {
            kind: "delete_attribute_schema",
            scope: scope(),
            target: target(),
          }
        : {
            kind: "set_attribute_schema",
            scope: scope(),
            target: target(),
            schema_json: next,
          },
    );
  };

  const save = () => {
    const found = validateProperties(items());
    setErrors(found);
    if (found.length === 0) void submit(toSchemaJson(items()));
  };

  const errorText = (index: number): string | null => {
    const found = errors().find((e) => e.index === index);
    return found === undefined ? null : t(`schema.itemError.${found.code}`);
  };

  return (
    <div class="schema-editor" ref={sync}>
      <div class="schema-target">
        <label class="field">
          <span>{t("schema.scope")}</span>
          <select
            value={scope()}
            onChange={(event) => {
              setScope(event.currentTarget.value as AttributeScope);
              setTarget("");
              sync();
            }}
          >
            <For each={SCOPES}>
              {(s) => <option value={s}>{t(`schema.scope.${s}`)}</option>}
            </For>
          </select>
        </label>
        <Show when={scope() === "label"}>
          <label class="field">
            <span>{t("schema.scope.label")}</span>
            <select
              value={target()}
              onChange={(event) => {
                setTarget(event.currentTarget.value);
                sync();
              }}
            >
              <option value="" />
              <For each={labels()}>
                {(l) => <option value={l.id}>{l.name}</option>}
              </For>
            </select>
          </label>
        </Show>
        <Show when={scope() !== "global" && scope() !== "label"}>
          <label class="field">
            <span>{t("schema.target")}</span>
            <input
              type="text"
              value={target()}
              onChange={(event) => {
                setTarget(event.currentTarget.value.trim());
                sync();
              }}
            />
          </label>
        </Show>
      </div>

      <Show
        when={items().length > 0}
        fallback={<p class="prop-empty">{t("schema.empty")}</p>}
      >
        <ul class="schema-props">
          <For each={items()}>
            {(item, index) => (
              <li class="schema-prop">
                <label class="field">
                  <span>{t("schema.field.name")}</span>
                  <input
                    type="text"
                    value={item.name}
                    onChange={(event) =>
                      update(index(), { name: event.currentTarget.value })
                    }
                  />
                </label>
                <label class="field">
                  <span>{t("schema.field.type")}</span>
                  <select
                    value={item.kind}
                    onChange={(event) =>
                      update(index(), {
                        kind: event.currentTarget
                          .value as EditorProperty["kind"],
                      })
                    }
                  >
                    <For each={KINDS}>
                      {(k) => (
                        <option value={k}>
                          {t(`schema.type.${k}` as MessageKey)}
                        </option>
                      )}
                    </For>
                  </select>
                </label>
                <label class="field">
                  <span>{t("schema.field.title")}</span>
                  <input
                    type="text"
                    value={item.title}
                    onChange={(event) =>
                      update(index(), { title: event.currentTarget.value })
                    }
                  />
                </label>
                <label class="field">
                  <span>{t("schema.field.description")}</span>
                  <input
                    type="text"
                    value={item.description}
                    onChange={(event) =>
                      update(index(), {
                        description: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                <Show when={item.kind === "enum"}>
                  <label class="field">
                    <span>{t("schema.field.options")}</span>
                    <input
                      type="text"
                      value={item.options.join(", ")}
                      onChange={(event) =>
                        update(index(), {
                          options: event.currentTarget.value
                            .split(",")
                            .map((o) => o.trim())
                            .filter((o) => o !== ""),
                        })
                      }
                    />
                  </label>
                </Show>
                <label class="field">
                  <span>{t("schema.field.default")}</span>
                  <input
                    type="text"
                    value={item.defaultText}
                    onChange={(event) =>
                      update(index(), {
                        defaultText: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                <label class="field schema-required">
                  <input
                    type="checkbox"
                    checked={item.required}
                    onChange={(event) =>
                      update(index(), { required: event.currentTarget.checked })
                    }
                  />
                  <span>{t("schema.field.required")}</span>
                </label>
                <button
                  type="button"
                  class="button"
                  onClick={() =>
                    setItems((list) => list.filter((_, i) => i !== index()))
                  }
                >
                  {t("labels.delete")}
                </button>
                <Show when={errorText(index())}>
                  {(text) => (
                    <small class="field-error" role="alert">
                      {text()}
                    </small>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={pendingCount() !== null}>
        <div class="draft-banner" role="alert">
          <span>
            {t("schema.impact.title")}:{" "}
            {format(t("schema.impact.count"), {
              count: String(pendingCount() ?? 0),
            })}
          </span>
          <button
            type="button"
            class="button primary"
            onClick={() =>
              void (items().length === 0 && stored() !== null
                ? submit(null)
                : submit(toSchemaJson(items())))
            }
          >
            {t("schema.impact.confirm")}
          </button>
          <button
            type="button"
            class="button"
            onClick={() => setPendingCount(null)}
          >
            {t("labels.cancel")}
          </button>
        </div>
      </Show>

      <div class="form-actions">
        <button
          type="button"
          class="button"
          onClick={() => setItems((list) => [...list, blankProperty()])}
        >
          {t("schema.field.add")}
        </button>
        <button type="button" class="button primary" onClick={save}>
          {t("schema.save")}
        </button>
        <Show when={stored() !== null}>
          <button
            type="button"
            class="button"
            onClick={() => void submit(null)}
          >
            {t("schema.delete")}
          </button>
        </Show>
      </div>
    </div>
  );
}
