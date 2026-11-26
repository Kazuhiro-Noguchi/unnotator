// リボンの縮退（specs/006-shell-layout/research.md R7）。DOM に触れない純関数。
import type { Form } from "../types";

/** 縮退の段階。大 → 小 → アイコンのみ → グループごとのドロップダウン。 */
export const FORMS: readonly Form[] = ["large", "small", "icon", "dropdown"];

export interface GroupMeasure {
  id: string;
  /** 小さいほど先に縮退する。 */
  priority: number;
  /** DOM で測った、各段階での幅（余白を含む）。 */
  widths: Record<Form, number>;
}

/**
 * 全グループを「大」から始め、収まらない間、段階ごとに縮退させる。
 * まず全グループを「小」まで（priority が小さいもの、同じなら右のものから 1 つずつ）、
 * それでも収まらなければ全グループを「アイコンのみ」まで、最後に「ドロップダウン」まで。
 * （1 つのグループを、ドロップダウンまで縮めてから次へ進むのではなく、小さいアイコンを先に出す。）
 * 毎回最初から計算するので、結果は履歴に依存せず、幅を広げれば単調に戻る。
 * 全部がドロップダウンでも収まらないときは、全部ドロップダウンを返す（残りははみ出し側で横スクロールにする）。
 */
export function fitGroups(
  groups: GroupMeasure[],
  available: number,
): Record<string, Form> {
  const level = new Map<string, number>(groups.map((g) => [g.id, 0]));
  const widthOf = (g: GroupMeasure) =>
    g.widths[FORMS[level.get(g.id) ?? 0] as Form];
  const total = () => groups.reduce((sum, g) => sum + widthOf(g), 0);
  // 縮退させる順（priority の昇順、同じなら右が先）。
  const order = groups
    .map((g, index) => ({ g, index }))
    .sort((a, b) => a.g.priority - b.g.priority || b.index - a.index)
    .map(({ g }) => g);

  for (let stage = 1; stage < FORMS.length && total() > available; stage++) {
    for (const g of order) {
      if (total() <= available) break;
      level.set(g.id, stage);
    }
  }
  return Object.fromEntries(
    groups.map((g) => [g.id, FORMS[level.get(g.id) ?? 0] as Form]),
  );
}
