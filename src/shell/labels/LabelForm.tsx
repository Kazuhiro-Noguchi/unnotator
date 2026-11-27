import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { MessageKey } from "../../i18n";
import { format } from "../../i18n";
import type { LabelRow } from "../project-data/types";
import { useT } from "../solid";
import { type LabelDraft, type LabelError, validateLabel } from "./validate";

export interface LabelFormProps {
  label: LabelRow;
  labels: readonly LabelRow[];
  /** 検証に通った変更を、すぐ書く（保存ボタンは無い）。 */
  onChange: (draft: LabelDraft & { hidden: boolean }) => void;
  /** Esc で閉じる。 */
  onClose: () => void;
  /** 削除の確認を開く（削除は、編集の中に置く）。 */
  onDelete: () => void;
}

const KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * ラベルの編集（即時変更）。名前・色・ショートカットキーは、変えた時点で検証し、通れば書く。
 * 通らないときは、理由を出して、書かない（入力した文字は、直せるように残す）。
 */
export function LabelForm(props: LabelFormProps) {
  const t = useT();
  const [name, setName] = createSignal(props.label.name);
  const [errors, setErrors] = createSignal<LabelError[]>([]);
  // 元に戻す・やり直すなど、外からの変更に、表示を合わせる。
  createEffect(
    on(
      () => props.label.name,
      (value) => {
        setName(value);
        setErrors([]);
      },
      { defer: true },
    ),
  );
  // 他のラベルが使っているキーは、選択肢に出さない（自分のキーは出す）。
  const takenKeys = () =>
    new Set(
      props.labels
        .filter((l) => l.id !== props.label.id && l.hotkey !== null)
        .map((l) => l.hotkey),
    );
  const freeKeys = () => KEYS.filter((k) => !takenKeys().has(k));

  const text = (error: LabelError): string => {
    const key = `labels.error.${error.code}` as MessageKey;
    return error.code === "hotkeyTaken"
      ? format(t(key), { key: String(error.key), name: error.name })
      : t(key);
  };

  /** 変えた項目を入れた下書きを検証し、通れば書く。 */
  const commit = (change: Partial<LabelDraft>) => {
    const draft = {
      name: name().trim(),
      color: props.label.color,
      hotkey: props.label.hotkey,
      ...change,
    };
    const found = validateLabel(draft, props.labels, props.label.id);
    setErrors(found);
    if (found.length === 0) {
      props.onChange({ ...draft, hidden: props.label.hidden });
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc で閉じるキー操作だけ（入力欄のキーは、ここで受ける）
    <div
      class="label-form"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <label class="field">
        <span>{t("labels.field.name")}</span>
        <input
          type="text"
          value={name()}
          ref={(el) =>
            queueMicrotask(() => {
              el.focus();
              el.select();
            })
          }
          onInput={(event) => setName(event.currentTarget.value)}
          onChange={() => commit({ name: name().trim() })}
        />
      </label>
      <label class="field">
        <span>{t("labels.field.color")}</span>
        <input
          type="color"
          value={props.label.color}
          onChange={(event) => commit({ color: event.currentTarget.value })}
        />
      </label>
      <label class="field">
        <span>{t("labels.field.hotkey")}</span>
        <select
          value={props.label.hotkey === null ? "" : String(props.label.hotkey)}
          onChange={(event) => {
            const value = event.currentTarget.value;
            commit({ hotkey: value === "" ? null : Number(value) });
          }}
        >
          <option value="">{t("labels.hotkey.none")}</option>
          <For each={freeKeys()}>
            {(k) => <option value={String(k)}>{k}</option>}
          </For>
        </select>
      </label>
      <button
        type="button"
        class="button danger"
        onClick={() => props.onDelete()}
      >
        {t("labels.delete")}
      </button>
      <Show when={errors().length > 0}>
        <ul class="form-errors" role="alert">
          <For each={errors()}>{(error) => <li>{text(error)}</li>}</For>
        </ul>
      </Show>
    </div>
  );
}
