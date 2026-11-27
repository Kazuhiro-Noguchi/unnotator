import { createSignal, For, onMount, Show } from "solid-js";
import { format } from "../../i18n";
import type { LabelRow, LabelUsage } from "../project-data/types";
import { useT } from "../solid";
import { type DeleteChoice, inUse, reassignCandidates } from "./delete";

export interface LabelDeleteProps {
  label: LabelRow;
  labels: readonly LabelRow[];
  loadUsage(labelId: string): Promise<LabelUsage>;
  onConfirm: (choice: DeleteChoice | null) => void;
  onCancel: () => void;
}

/** ラベルの削除の確認。使われているときは、件数を示して、付け替えか一緒に削除かを選ばせる。 */
export function LabelDelete(props: LabelDeleteProps) {
  const t = useT();
  const [usage, setUsage] = createSignal<LabelUsage | null>(null);
  const [mode, setMode] = createSignal<"reassign" | "cascade">("cascade");
  const candidates = () => reassignCandidates(props.labels, props.label.id);
  const [target, setTarget] = createSignal(candidates()[0]?.id ?? "");
  onMount(() => void props.loadUsage(props.label.id).then(setUsage));

  const total = () => {
    const u = usage();
    return u === null ? 0 : u.annotations + u.relations + u.groups;
  };
  const choice = (): DeleteChoice | null => {
    const u = usage();
    if (u === null || !inUse(u)) return null;
    return mode() === "reassign" && target() !== ""
      ? { kind: "reassign", toLabelId: target() }
      : { kind: "cascade" };
  };

  return (
    <div class="label-delete" role="alertdialog" aria-label={props.label.name}>
      <p>{format(t("labels.delete.title"), { name: props.label.name })}</p>
      <Show when={usage()}>
        {(u) => (
          <>
            <p>
              {inUse(u())
                ? format(t("labels.delete.usage"), { count: String(total()) })
                : t("labels.delete.unused")}
            </p>
            <Show when={u().attribute_schemas > 0}>
              <p>{t("labels.delete.schemas")}</p>
            </Show>
            <Show when={inUse(u())}>
              <label class="field label-hidden-field">
                <input
                  type="radio"
                  name="label-delete-mode"
                  checked={mode() === "reassign"}
                  disabled={candidates().length === 0}
                  onChange={() => setMode("reassign")}
                />
                <span>{t("labels.delete.reassign")}</span>
              </label>
              <Show when={mode() === "reassign"}>
                <label class="field">
                  <span>{t("labels.delete.target")}</span>
                  <select
                    value={target()}
                    onChange={(event) => setTarget(event.currentTarget.value)}
                  >
                    <For each={candidates()}>
                      {(l) => <option value={l.id}>{l.name}</option>}
                    </For>
                  </select>
                </label>
              </Show>
              <label class="field label-hidden-field">
                <input
                  type="radio"
                  name="label-delete-mode"
                  checked={mode() === "cascade"}
                  onChange={() => setMode("cascade")}
                />
                <span>{t("labels.delete.cascade")}</span>
              </label>
            </Show>
          </>
        )}
      </Show>
      <div class="form-actions">
        <button
          type="button"
          class="button primary"
          disabled={usage() === null}
          onClick={() => props.onConfirm(choice())}
        >
          {t("labels.delete.confirm")}
        </button>
        <button type="button" class="button" onClick={props.onCancel}>
          {t("labels.cancel")}
        </button>
      </div>
    </div>
  );
}
