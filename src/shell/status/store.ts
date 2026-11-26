// ステータスバーの状態（specs/006-shell-layout/data-model.md の StatusState・StatusItem）。
import type { StatusItem, StatusState } from "../types";

interface ItemKey {
  source: string;
  id: string;
}

export function createStatusStore() {
  let state: StatusState = { message: null, progress: null, jobs: 0 };
  const items = new Map<string, StatusItem>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const keyOf = (key: ItemKey) => `${key.source}\u0000${key.id}`;

  return {
    state: (): StatusState => state,

    setMessage(message: string | null): void {
      state = { ...state, message };
      emit();
    },

    /** 完了数 / 総数。総数が 0 以下・負の値は「進捗なし」、完了数は総数に収める。 */
    setProgress(progress: { done: number; total: number } | null): void {
      let next: StatusState["progress"] = null;
      if (progress && progress.total > 0 && progress.done >= 0) {
        next = {
          done: Math.min(progress.done, progress.total),
          total: progress.total,
        };
      }
      state = { ...state, progress: next };
      emit();
    },

    setJobs(jobs: number): void {
      state = { ...state, jobs: Math.max(0, Math.floor(jobs)) };
      emit();
    },

    /** 進捗の割合（整数の %）。進捗が無ければ null。 */
    percent(): number | null {
      const p = state.progress;
      return p ? Math.round((p.done / p.total) * 100) : null;
    },

    /** 送り元ごとの項目。null で消える。同じ（送り元・id）は置き換わる。 */
    setItem(item: StatusItem | null, key: ItemKey): void {
      if (item === null) items.delete(keyOf(key));
      else items.set(keyOf(key), item);
      emit();
    },

    removeSource(source: string): void {
      for (const [k, item] of items) {
        if (item.source === source) items.delete(k);
      }
      emit();
    },

    /** priority の大きいものが端に近い。同じなら登録順。 */
    items(alignment: "left" | "right"): StatusItem[] {
      return [...items.values()]
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.alignment === alignment)
        .sort((a, b) => b.item.priority - a.item.priority || a.index - b.index)
        .map(({ item }) => item);
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type StatusStore = ReturnType<typeof createStatusStore>;
