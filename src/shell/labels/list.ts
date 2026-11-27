// ラベルの一覧の純関数（絞り込み・次の並び順）。
import type { LabelRow } from "../project-data/types";

/** 名前の一部（大文字小文字を区別しない）で絞り込む。順序は保つ。 */
export function filterLabels(
  labels: readonly LabelRow[],
  query: string,
): LabelRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...labels];
  return labels.filter((l) => l.name.toLowerCase().includes(needle));
}

/** 末尾に置く並び順。 */
export function nextSortOrder(labels: readonly LabelRow[]): number {
  return labels.reduce((max, l) => Math.max(max, l.sort_order), -1) + 1;
}

/** 新しいラベルの色。ラベルの数ごとに色相を黄金角でずらし、見分けやすくする（`#RRGGBB`）。 */
export function defaultLabelColor(count: number): string {
  const hue = (count * 137.508) % 360;
  const [s, l] = [0.65, 0.5];
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/**
 * ラベルを `toIndex`（動かしたあとの位置）へ動かしたあとの並びを、先頭から 0, 1, 2… と振り直し、
 * 値が変わるラベルだけを返す。同じ位置・範囲外・知らない ID なら `null`。同じ値が並んでいても、位置どおりに動く。
 */
export function reorderLabels(
  labels: readonly LabelRow[],
  id: string,
  toIndex: number,
): Array<{ id: string; sort_order: number }> | null {
  const index = labels.findIndex((l) => l.id === id);
  if (index < 0 || toIndex < 0 || toIndex >= labels.length) return null;
  if (index === toIndex) return null;
  const order = [...labels];
  const [moved] = order.splice(index, 1);
  if (moved === undefined) return null;
  order.splice(toIndex, 0, moved);
  return order
    .map((l, position) => ({ label: l, position }))
    .filter(({ label, position }) => label.sort_order !== position)
    .map(({ label, position }) => ({ id: label.id, sort_order: position }));
}

/** 1 つ上・下へ動かす（キーボード用）。端なら `null`。 */
export function moveLabel(
  labels: readonly LabelRow[],
  id: string,
  direction: "up" | "down",
): Array<{ id: string; sort_order: number }> | null {
  const index = labels.findIndex((l) => l.id === id);
  return reorderLabels(labels, id, direction === "up" ? index - 1 : index + 1);
}

/** ドラッグの落とし先。各カードの中心の縦の位置と、ポインターの位置から、挿入位置（0〜件数）を返す。 */
export function dropIndexFor(centers: readonly number[], y: number): number {
  return centers.filter((center) => center < y).length;
}

/** 挿入位置（取り除く前の数え方）を、取り除いたあとの位置に直す。 */
export function finalIndex(from: number, insertion: number): number {
  return insertion > from ? insertion - 1 : insertion;
}

/** 新しいラベルの名前。`base`（「新しいラベル」）が使われていれば、「新しいラベル 2」「…3」と数を付ける。 */
export function newLabelName(
  labels: readonly LabelRow[],
  base: string,
): string {
  const taken = new Set(labels.map((l) => l.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
