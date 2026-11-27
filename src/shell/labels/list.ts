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
 * 1 つ上・下へ動かしたあとの並びを、先頭から 0, 1, 2… と振り直し、値が変わるラベルだけを返す。端なら `null`。
 * 同じ値が並んでいても、位置どおりに動く。
 */
export function moveLabel(
  labels: readonly LabelRow[],
  id: string,
  direction: "up" | "down",
): Array<{ id: string; sort_order: number }> | null {
  const index = labels.findIndex((l) => l.id === id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= labels.length) return null;
  const order = [...labels];
  const [moved] = order.splice(index, 1);
  if (moved === undefined) return null;
  order.splice(target, 0, moved);
  return order
    .map((l, position) => ({ label: l, position }))
    .filter(({ label, position }) => label.sort_order !== position)
    .map(({ label, position }) => ({ id: label.id, sort_order: position }));
}
