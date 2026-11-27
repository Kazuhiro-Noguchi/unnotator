// ラベルの作成・変更の検証。純関数。コア（DB の CHECK・一意制約）と同じ条件を、保存の前に知らせる。
import type { LabelRow } from "../project-data/types";

export interface LabelDraft {
  name: string;
  color: string;
  hotkey: number | null;
}

export type LabelError =
  | { field: "name"; code: "nameEmpty" | "nameDuplicate" }
  | { field: "color"; code: "color" }
  | { field: "hotkey"; code: "hotkeyRange" }
  | { field: "hotkey"; code: "hotkeyTaken"; key: number; name: string };

const COLOR = /^#[0-9A-Fa-f]{6}$/;

/** `selfId` は、変更中のラベルの ID（自分自身は、重複とみなさない）。 */
export function validateLabel(
  draft: LabelDraft,
  labels: readonly LabelRow[],
  selfId: string | null,
): LabelError[] {
  const errors: LabelError[] = [];
  const others = labels.filter((l) => l.id !== selfId);
  const name = draft.name.trim();
  if (name === "") errors.push({ field: "name", code: "nameEmpty" });
  else if (others.some((l) => l.name === name)) {
    errors.push({ field: "name", code: "nameDuplicate" });
  }
  if (!COLOR.test(draft.color)) errors.push({ field: "color", code: "color" });
  const key = draft.hotkey;
  if (key !== null) {
    if (!Number.isInteger(key) || key < 1 || key > 9) {
      errors.push({ field: "hotkey", code: "hotkeyRange" });
    } else {
      const taken = others.find((l) => l.hotkey === key);
      if (taken !== undefined) {
        errors.push({
          field: "hotkey",
          code: "hotkeyTaken",
          key,
          name: taken.name,
        });
      }
    }
  }
  return errors;
}
