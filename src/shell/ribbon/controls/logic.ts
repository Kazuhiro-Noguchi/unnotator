// リボンのコントロールの論理（DOM に触れない部分）。
import type { RibbonControl } from "../../types";

export interface Invocation {
  command: string;
  args?: unknown;
}

/** 数値入力の確定。範囲外・非数値は確定せず、直前の値に戻す。刻みに丸める。 */
export function commitNumber(
  text: string,
  range: { min: number; max: number; step: number },
  last: number,
): { commit: boolean; value: number } {
  const trimmed = text.trim();
  const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < range.min || parsed > range.max) {
    return { commit: false, value: last };
  }
  const steps = Math.round((parsed - range.min) / range.step);
  const snapped = range.min + steps * range.step;
  // 小数の刻みの誤差（0.30000000000000004 など）を落とす。
  const value = Number(snapped.toFixed(10));
  return {
    commit: true,
    value: Math.min(range.max, Math.max(range.min, value)),
  };
}

function invocationOf(control: RibbonControl): Invocation | null {
  if (!control.command) return null;
  return control.args === undefined
    ? { command: control.command }
    : { command: control.command, args: control.args };
}

/** ギャラリーで、選んだ項目のコマンドと引数。範囲外は null。 */
export function galleryInvocation(
  gallery: RibbonControl,
  index: number,
): Invocation | null {
  const item = gallery.items?.[index];
  return item ? invocationOf(item) : null;
}

/** ボタン・分割ボタンの主ボタン。分割ボタンは、自分のコマンド、無ければ最初の項目。 */
export function primaryInvocation(control: RibbonControl): Invocation | null {
  const own = invocationOf(control);
  if (own) return own;
  const first = control.items?.[0];
  return first ? invocationOf(first) : null;
}
