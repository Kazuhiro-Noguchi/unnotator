// キーチップ（Alt で出る 1 文字の案内）の割り当てとモードの状態機械（research.md R8）。DOM に触れない。

export interface TipItem {
  target: string;
  label: string;
  /** コアの定義に書いた固定のキーチップ。 */
  fixed?: string;
}

export interface KeyTip {
  target: string;
  /** 空文字は「チップなし」（37 個目以降）。 */
  chip: string;
}

const POOL = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];

/**
 * 同じ階層のチップを重複なく割り当てる。固定 → 表示名の文字 → 空いている文字、の順。
 * 同じ入力には同じ出力。言語が変わっても、固定のキーチップは変わらない。
 */
export function assignKeyTips(items: TipItem[]): KeyTip[] {
  const used = new Set<string>();
  const chips = new Map<string, string>();

  for (const item of items) {
    const fixed = item.fixed?.toUpperCase();
    if (fixed && !used.has(fixed)) {
      used.add(fixed);
      chips.set(item.target, fixed);
    }
  }
  for (const item of items) {
    if (chips.has(item.target)) continue;
    const fromLabel = [...item.label.toUpperCase()].find(
      (ch) => /[A-Z0-9]/.test(ch) && !used.has(ch),
    );
    const chip = fromLabel ?? POOL.find((ch) => !used.has(ch));
    if (chip) {
      used.add(chip);
      chips.set(item.target, chip);
    }
  }
  return items.map((item) => ({
    target: item.target,
    chip: chips.get(item.target) ?? "",
  }));
}

// ---- モード ----

export type KeyTipState =
  | { level: "off" }
  | { level: "tabs" }
  | { level: "controls"; tab: string };

export type KeyTipAction =
  | { type: "alt" }
  | { type: "escape" }
  | { type: "key"; key: string };

export interface KeyTipSource {
  /** タブとクイックアクセスのチップ（`tab:<id>` / `qa:<commandId>`）。 */
  tabs: () => KeyTip[];
  /** 開いているタブのコントロールのチップ（`control:<tab>/<index>`）。 */
  controls: (tab: string) => KeyTip[];
}

export interface KeyTipStep {
  state: KeyTipState;
  /** 実行する対象（タブを開く・コマンドを実行する）。 */
  activate?: { target: string };
}

export function reduceKeyTips(
  state: KeyTipState,
  action: KeyTipAction,
  source: KeyTipSource,
): KeyTipStep {
  switch (action.type) {
    case "alt":
      return {
        state: state.level === "off" ? { level: "tabs" } : { level: "off" },
      };
    case "escape":
      if (state.level === "controls") return { state: { level: "tabs" } };
      return { state: { level: "off" } };
    case "key": {
      if (state.level === "off") return { state };
      const key = action.key.toUpperCase();
      if (state.level === "tabs") {
        const hit = source.tabs().find((tip) => tip.chip === key);
        if (!hit) return { state };
        if (hit.target.startsWith("tab:")) {
          return {
            state: { level: "controls", tab: hit.target.slice("tab:".length) },
            activate: { target: hit.target },
          };
        }
        return { state: { level: "off" }, activate: { target: hit.target } };
      }
      const hit = source.controls(state.tab).find((tip) => tip.chip === key);
      if (!hit) return { state };
      return { state: { level: "off" }, activate: { target: hit.target } };
    }
  }
}

/** Alt を単独で押して離したこと（tap）を検出する。間に他のキーやマウス操作があれば tap ではない。 */
export function createAltTapDetector() {
  let pending = false;
  return {
    keydown(key: string): boolean {
      if (key === "Alt") {
        if (!pending) pending = true;
      } else {
        pending = false;
      }
      return false;
    },
    keyup(key: string): boolean {
      if (key !== "Alt") return false;
      const tap = pending;
      pending = false;
      return tap;
    },
    cancel(): void {
      pending = false;
    },
  };
}
