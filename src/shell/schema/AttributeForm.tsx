import { createSignal, For, Show } from "solid-js";
import type { MessageKey } from "../../i18n";
import { useT } from "../solid";
import { type Attributes, withValue } from "./attributes";
import {
  type FieldError,
  type FormField,
  fieldIssues,
  parseValue,
} from "./derive-form";

export interface AttributeFormProps {
  fields: readonly FormField[];
  /** 保存済みの値。 */
  attributes: Attributes;
  /** 確定した値（スキーマに無いキーを含む全体）。 */
  onCommit: (next: Attributes) => void;
}

/** 属性スキーマから導いたフォーム。型に合わない入力は確定せず、理由を示す。 */
export function AttributeForm(props: AttributeFormProps) {
  const t = useT();
  const [typed, setTyped] = createSignal<Record<string, FieldError>>({});
  const issues = () => fieldIssues(props.fields, props.attributes);

  const setError = (name: string, error: FieldError | null) =>
    setTyped((current) => {
      const next = { ...current };
      if (error === null) delete next[name];
      else next[name] = error;
      return next;
    });

  const commit = (field: FormField, value: unknown) => {
    setError(field.name, null);
    if (props.attributes[field.name] === value) return;
    props.onCommit(withValue(props.attributes, field.name, value));
  };

  const text = (field: FormField, raw: string) => {
    const parsed = parseValue(field, raw);
    if (!parsed.ok) return setError(field.name, parsed.error);
    commit(field, parsed.value);
  };

  const message = (field: FormField): MessageKey | null => {
    const error = typed()[field.name] ?? issues()[field.name]?.error;
    if (error !== undefined) return `schema.error.${error}`;
    return issues()[field.name]?.mismatch ? "schema.warn.mismatch" : null;
  };

  const shown = (field: FormField): string => {
    const stored = props.attributes[field.name];
    const value = stored === undefined ? field.defaultValue : stored;
    return value === undefined ? "" : String(value);
  };

  return (
    <div class="attribute-form">
      <For each={props.fields}>
        {(field) => (
          <label class="field attribute-field">
            <span>
              {field.title}
              <Show when={field.required}>
                <abbr title={t("schema.field.required")}> *</abbr>
              </Show>
            </span>
            <Show when={field.kind === "boolean"}>
              <input
                type="checkbox"
                checked={shown(field) === "true"}
                onChange={(event) => commit(field, event.currentTarget.checked)}
              />
            </Show>
            <Show when={field.kind === "enum"}>
              <select
                value={shown(field)}
                onChange={(event) =>
                  commit(field, event.currentTarget.value || undefined)
                }
              >
                <option value="" />
                <For each={field.options}>
                  {(option) => <option value={option}>{option}</option>}
                </For>
              </select>
            </Show>
            <Show
              when={
                field.kind === "string" ||
                field.kind === "number" ||
                field.kind === "integer"
              }
            >
              <input
                type="text"
                inputMode={field.kind === "string" ? "text" : "decimal"}
                value={shown(field)}
                onChange={(event) => text(field, event.currentTarget.value)}
              />
            </Show>
            <Show when={field.description}>
              <small class="field-hint">{field.description}</small>
            </Show>
            <Show when={message(field)}>
              {(key) => (
                <small class="field-error" role="alert">
                  {t(key())}
                </small>
              )}
            </Show>
          </label>
        )}
      </For>
    </div>
  );
}
