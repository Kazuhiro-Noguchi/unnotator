// ラベルのビューの、見出しの操作（追加・絞り込み）と一覧が共有する状態。
import { createSignal } from "solid-js";

export interface LabelsUi {
  /** 見出しの「追加」から呼ぶ。一覧が登録した処理で、すぐにラベルを作る。一覧が無いときは、何もしない。 */
  create(): void;
  /** 一覧が、追加の処理を登録する（閉じるときは `null`）。 */
  setCreateHandler(handler: (() => void) | null): void;
  /** 絞り込みの入力を出しているか。 */
  filterOpen(): boolean;
  setFilterOpen(value: boolean): void;
  /** 名前の絞り込み。 */
  query(): string;
  setQuery(value: string): void;
  /** 選択中のラベルの ID（無ければ `null`）。ほかの部品が、選択中のラベルを使えるよう、ここに持つ。 */
  selected(): string | null;
  setSelected(id: string | null): void;
}

export function createLabelsUi(): LabelsUi {
  let createHandler: (() => void) | null = null;
  const [filterOpen, setFilterOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<string | null>(null);
  return {
    create: () => createHandler?.(),
    setCreateHandler: (handler) => {
      createHandler = handler;
    },
    filterOpen,
    setFilterOpen: (value) => {
      setFilterOpen(value);
      // 絞り込みを閉じたら、条件も外す（隠れた条件で、一覧が減ったままにならないように）。
      if (!value) setQuery("");
    },
    query,
    setQuery: (value) => setQuery(value),
    selected,
    setSelected: (id) => setSelected(id),
  };
}

/** アプリで使う 1 つ。 */
export const labelsUi: LabelsUi = createLabelsUi();
