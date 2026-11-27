import { createSignal, For, Show } from "solid-js";
import type { MessageKey } from "../../i18n";
import { format } from "../../i18n";
import type { LabelRow } from "../project-data/types";
import { useT } from "../solid";
import { defaultLabelColor } from "./list";
import { type LabelDraft, type LabelError, validateLabel } from "./validate";

export interface LabelFormProps {
  /** 変更するラベル。作るときは `null`。 */
  label: LabelRow | null;
  labels: readonly LabelRow[];
  onSubmit: (draft: LabelDraft & { hidden: boolean }) => void;
  onCancel: () => void;
}

const KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** ラベルの作成・変更のフォーム。検証は `validateLabel`。 */
export function LabelForm(props: LabelFormProps) {
  const t = useT();
  const [name, setName] = createSignal(props.label?.name ?? "");
  const [color, setColor] = createSignal(
    props.label?.color ?? defaultLabelColor(props.labels.length),
  );
  const [hotkey, setHotkey] = createSignal<number | null>(
    props.label?.hotkey ?? null,
  );
  const [hidden, setHidden] = createSignal(props.label?.hidden ?? false);
  const [errors, setErrors] = createSignal<LabelError[]>([]);

  const text = (error: LabelError): string => {
    const key = `labels.error.${error.code}` as MessageKey;
    return error.code === "hotkeyTaken"
      ? format(t(key), { key: String(error.key), name: error.name })
      : t(key);
  };

  const submit = (event: Event) => {
    event.preventDefault();
    const draft = { name: name().trim(), color: color(), hotkey: hotkey() };
    const found = validateLabel(draft, props.labels, props.label?.id ?? null);
    setErrors(found);
    if (found.length === 0) props.onSubmit({ ...draft, hidden: hidden() });
  };

  return (
    <form class="label-form" onSubmit={submit}>
      <label class="field">
        <span>{t("labels.field.name")}</span>
        <input
          type="text"
          value={name()}
          ref={(el) => queueMicrotask(() => el.focus())}
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label class="field">
        <span>{t("labels.field.color")}</span>
        <input
          type="color"
          value={color()}
          onInput={(event) => setColor(event.currentTarget.value)}
        />
      </label>
      <label class="field">
        <span>{t("labels.field.hotkey")}</span>
        <select
          value={hotkey() === null ? "" : String(hotkey())}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setHotkey(value === "" ? null : Number(value));
          }}
        >
          <option value="">{t("labels.hotkey.none")}</option>
          <For each={KEYS}>{(k) => <option value={String(k)}>{k}</option>}</For>
        </select>
      </label>
      <label class="field label-hidden-field">
        <input
          type="checkbox"
          checked={hidden()}
          onChange={(event) => setHidden(event.currentTarget.checked)}
        />
        <span>{t("labels.field.hidden")}</span>
      </label>
      <Show when={errors().length > 0}>
        <ul class="form-errors" role="alert">
          <For each={errors()}>{(error) => <li>{text(error)}</li>}</For>
        </ul>
      </Show>
      <div class="form-actions">
        <button type="submit" class="button primary">
          {t("labels.save")}
        </button>
        <button type="button" class="button" onClick={props.onCancel}>
          {t("labels.cancel")}
        </button>
      </div>
    </form>
  );
}
