// ラベルのビューの、見出しの操作（追加・絞り込み）と一覧が共有する状態。
import { createSignal } from "solid-js";

export interface LabelsUi {
  /** 追加フォームを開いているか。 */
  creating(): boolean;
  setCreating(value: boolean): void;
  /** 絞り込みの入力を出しているか。 */
  filterOpen(): boolean;
  setFilterOpen(value: boolean): void;
  /** 名前の絞り込み。 */
  query(): string;
  setQuery(value: string): void;
}

export function createLabelsUi(): LabelsUi {
  const [creating, setCreating] = createSignal(false);
  const [filterOpen, setFilterOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  return {
    creating,
    setCreating: (value) => setCreating(value),
    filterOpen,
    setFilterOpen: (value) => {
      setFilterOpen(value);
      // 絞り込みを閉じたら、条件も外す（隠れた条件で、一覧が減ったままにならないように）。
      if (!value) setQuery("");
    },
    query,
    setQuery: (value) => setQuery(value),
  };
}

/** アプリで使う 1 つ。 */
export const labelsUi: LabelsUi = createLabelsUi();
