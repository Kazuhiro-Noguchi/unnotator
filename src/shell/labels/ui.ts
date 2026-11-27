// ラベルのビューの、見出しの操作（追加・絞り込み）と一覧が共有する状態。
import { createSignal } from "solid-js";
import {
  applyClick,
  type ClickMode,
  EMPTY_SELECTION,
  type LabelSelection,
} from "./selection";

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
  /** 選択中のラベル（複数）。クリックまたはショートカットキー（1〜9）で選ぶ。分類とは別。 */
  selection(): LabelSelection;
  setSelection(selection: LabelSelection): void;
  /** クリック（通常・Ctrl / Cmd・Shift）に従って、選択を変える。`order` は、見えているラベルの並び。 */
  click(id: string, mode: ClickMode, order: readonly string[]): void;
  /** 選択を、すべて解除する。 */
  clearSelection(): void;
}

export function createLabelsUi(): LabelsUi {
  let createHandler: (() => void) | null = null;
  const [filterOpen, setFilterOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [selection, setSelection] =
    createSignal<LabelSelection>(EMPTY_SELECTION);
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
    selection,
    setSelection: (value) => setSelection(value),
    click: (id, mode, order) =>
      setSelection((current) => applyClick(current, id, mode, order)),
    clearSelection: () => setSelection(EMPTY_SELECTION),
  };
}

/** アプリで使う 1 つ。 */
export const labelsUi: LabelsUi = createLabelsUi();
