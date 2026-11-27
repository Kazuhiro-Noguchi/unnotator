// 入力途中の値（下書き）。現在位置が変わっても、黙って失わない（FR-012）。純粋なストア。
//
// 位置を変えたとき、下書きが残っていれば「保留」に回し、利用者が確定するか破棄するかを選ぶまで保つ。

export interface DraftField {
  field: string;
  /** 編集を始めたときの値（元に戻したら、下書きではなくなる）。 */
  original: string;
  value: string;
}

export interface Draft {
  /** 下書きの持ち主の位置（アセット、またはアイテムのキー）。 */
  targetKey: string;
  fields: DraftField[];
}

export type SwitchResult = "same" | "clean" | "pending";

export interface DraftStore {
  /** 現在位置が変わったとき。下書きがあれば保留に回す。 */
  switchTo(targetKey: string): SwitchResult;
  edit(field: string, original: string, value: string): void;
  /** 下書きの値。無ければ `undefined`（元の値を使う）。 */
  valueOf(field: string): string | undefined;
  dirty(): boolean;
  /** 書き込みが済んだ欄の下書きを消す。 */
  committed(field: string): void;
  /** いちばん古い保留。 */
  pending(): Draft | null;
  /** 保留を片づける。確定を選んだときは、その内容を返す（呼び出し側が書き込む）。 */
  resolvePending(choice: "apply" | "discard"): Draft | null;
  subscribe(listener: () => void): () => void;
}

export function createDraftStore(): DraftStore {
  let targetKey: string | null = null;
  let fields = new Map<string, { original: string; value: string }>();
  const held: Draft[] = [];
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const snapshot = (): DraftField[] =>
    [...fields].map(([field, f]) => ({ field, ...f }));

  return {
    switchTo(next) {
      if (next === targetKey) return "same";
      let result: SwitchResult = "clean";
      if (targetKey !== null && fields.size > 0) {
        held.push({ targetKey, fields: snapshot() });
        result = "pending";
      }
      targetKey = next;
      fields = new Map();
      emit();
      return result;
    },
    edit(field, original, value) {
      if (value === original) fields.delete(field);
      else fields.set(field, { original, value });
      emit();
    },
    valueOf: (field) => fields.get(field)?.value,
    dirty: () => fields.size > 0,
    committed(field) {
      if (fields.delete(field)) emit();
    },
    pending: () => held[0] ?? null,
    resolvePending(choice) {
      const draft = held.shift() ?? null;
      emit();
      return choice === "apply" ? draft : null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const SEP = "\u0000";

/** 下書きの持ち主の位置を表すキー。 */
export function targetKeyOf(assetId: string, itemKey: string | null): string {
  return `${assetId}${SEP}${itemKey ?? ""}`;
}

export function parseTargetKey(key: string): {
  assetId: string;
  itemKey: string | null;
} {
  const at = key.indexOf(SEP);
  const itemKey = key.slice(at + 1);
  return {
    assetId: key.slice(0, at),
    itemKey: itemKey === "" ? null : itemKey,
  };
}
