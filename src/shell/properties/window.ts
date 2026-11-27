// 仮想スクロールの窓。固定の行の高さで、見える範囲の前後だけを描く。純関数。

export interface RowWindow {
  /** 先頭の行（含む）。 */
  start: number;
  /** 末尾の行（含まない）。 */
  end: number;
}

export function visibleWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  overscan: number,
): RowWindow {
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const count = Math.ceil(Math.max(0, viewportHeight) / rowHeight);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(total, first + count + overscan),
  };
}
