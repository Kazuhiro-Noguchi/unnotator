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
