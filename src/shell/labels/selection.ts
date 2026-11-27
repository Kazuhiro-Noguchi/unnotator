// ラベルの選択（複数）。純関数。
//
// クリック: そのラベルだけを選ぶ（選択中の 1 つだけを押すと、解除）。Ctrl / Cmd + クリック: 選択に足す・外す。
// Shift + クリック: 起点から、押したものまでの範囲。選択の最後のものが、主なラベル（拡張機能の `labels.active()`）。

export interface LabelSelection {
  /** 選ばれた順。最後が、主なラベル。 */
  ids: readonly string[];
  /** Shift + クリックの起点（最後に、通常・Ctrl / Cmd で押したもの）。 */
  anchor: string | null;
}

export const EMPTY_SELECTION: LabelSelection = { ids: [], anchor: null };

export type ClickMode = "replace" | "toggle" | "range";

/** `order` は、いま見えているラベルの並び（範囲の計算に使う）。 */
export function applyClick(
  current: LabelSelection,
  clicked: string,
  mode: ClickMode,
  order: readonly string[],
): LabelSelection {
  switch (mode) {
    case "replace":
      return current.ids.length === 1 && current.ids[0] === clicked
        ? EMPTY_SELECTION
        : { ids: [clicked], anchor: clicked };
    case "toggle":
      return {
        ids: current.ids.includes(clicked)
          ? current.ids.filter((id) => id !== clicked)
          : [...current.ids, clicked],
        anchor: clicked,
      };
    case "range": {
      const from = order.indexOf(current.anchor ?? "");
      const to = order.indexOf(clicked);
      if (from < 0 || to < 0) return { ids: [clicked], anchor: clicked };
      const range =
        from <= to ? order.slice(from, to + 1) : order.slice(to, from + 1);
      // 起点を先頭に、押したものを最後にする（最後が、主なラベル）。
      const rest = range.filter((id) => id !== clicked && id !== order[from]);
      const ids = [order[from] as string, ...rest, clicked].filter(
        (id, i, all) => all.indexOf(id) === i,
      );
      return { ids, anchor: current.anchor };
    }
  }
}

/** `allowed` に無いもの（消えた・非表示）を外す。変わらなければ、同じものを返す。 */
export function pruneSelection(
  selection: LabelSelection,
  allowed: ReadonlySet<string>,
): LabelSelection {
  const ids = selection.ids.filter((id) => allowed.has(id));
  if (ids.length === selection.ids.length) return selection;
  return {
    ids,
    anchor:
      selection.anchor !== null && allowed.has(selection.anchor)
        ? selection.anchor
        : null,
  };
}
