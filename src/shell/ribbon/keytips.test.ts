import { describe, expect, it } from "vitest";
import {
  assignKeyTips,
  createAltTapDetector,
  type KeyTipState,
  reduceKeyTips,
} from "./keytips";

const chips = (items: Parameters<typeof assignKeyTips>[0]) =>
  Object.fromEntries(assignKeyTips(items).map((t) => [t.target, t.chip]));

describe("キーチップの割り当て", () => {
  it("固定のキーチップが優先される", () => {
    expect(
      chips([
        { target: "tab:file", label: "File", fixed: "F" },
        { target: "tab:fmt", label: "Format" },
      ]),
    ).toEqual({ "tab:file": "F", "tab:fmt": "O" });
  });

  it("自動の割り当ては、表示名の先頭の文字から。使われていれば次の文字", () => {
    expect(
      chips([
        { target: "a", label: "Save" },
        { target: "b", label: "Select" },
        { target: "c", label: "Search" },
      ]),
    ).toEqual({ a: "S", b: "E", c: "A" });
  });

  it("同じ階層で重複しない", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      target: `t${i}`,
      label: "Same",
    }));
    const result = assignKeyTips(items).map((t) => t.chip);
    expect(new Set(result).size).toBe(30);
    for (const chip of result) expect(chip).toMatch(/^[A-Z0-9]$/);
  });

  it("日本語など英数字が無い表示名でも、空いている文字を割り当てる", () => {
    const result = chips([
      { target: "a", label: "保存" },
      { target: "b", label: "開く" },
    ]);
    expect(result.a).toMatch(/^[A-Z0-9]$/);
    expect(result.b).toMatch(/^[A-Z0-9]$/);
    expect(result.a).not.toBe(result.b);
  });

  it("固定のキーチップ同士が衝突したら、後のものを自動にする", () => {
    const result = chips([
      { target: "a", label: "Alpha", fixed: "X" },
      { target: "b", label: "Beta", fixed: "X" },
    ]);
    expect(result.a).toBe("X");
    expect(result.b).not.toBe("X");
  });

  it("同じ入力には、同じ出力", () => {
    const items = [
      { target: "a", label: "Save" },
      { target: "b", label: "Select", fixed: "S" },
      { target: "c", label: "保存" },
    ];
    expect(assignKeyTips(items)).toEqual(assignKeyTips(items));
  });

  it("言語が変わっても、固定のキーチップは変わらない", () => {
    const ja = chips([{ target: "tab:home", label: "ホーム", fixed: "H" }]);
    const en = chips([{ target: "tab:home", label: "Home", fixed: "H" }]);
    expect(ja["tab:home"]).toBe(en["tab:home"]);
  });

  it("36 を超える項目は、チップを持たない（空文字）", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      target: `t${i}`,
      label: `Item ${i}`,
    }));
    const result = assignKeyTips(items);
    expect(result.filter((t) => t.chip !== "")).toHaveLength(36);
  });
});

describe("キーチップのモード", () => {
  const tabs = [
    { target: "tab:home", chip: "H" },
    { target: "tab:view", chip: "W" },
    { target: "qa:core.undo", chip: "1" },
  ];
  const controls = [
    { target: "control:home/0", chip: "V" },
    { target: "control:home/1", chip: "C" },
  ];
  const source = { tabs: () => tabs, controls: (_tab: string) => controls };
  const step = (
    state: KeyTipState,
    action: Parameters<typeof reduceKeyTips>[1],
  ) => reduceKeyTips(state, action, source);

  it("Alt で、タブのレベルに入り、もう一度で閉じる", () => {
    const on = step({ level: "off" }, { type: "alt" });
    expect(on.state).toEqual({ level: "tabs" });
    expect(step(on.state, { type: "alt" }).state).toEqual({ level: "off" });
  });

  it("タブのチップで、そのタブが開き、コントロールのレベルに進む", () => {
    const result = step({ level: "tabs" }, { type: "key", key: "h" });
    expect(result.state).toEqual({ level: "controls", tab: "home" });
    expect(result.activate).toEqual({ target: "tab:home" });
  });

  it("クイックアクセスのチップは、実行してモードを閉じる", () => {
    const result = step({ level: "tabs" }, { type: "key", key: "1" });
    expect(result.state).toEqual({ level: "off" });
    expect(result.activate).toEqual({ target: "qa:core.undo" });
  });

  it("コントロールのチップで、実行してモードを閉じる", () => {
    const result = step(
      { level: "controls", tab: "home" },
      { type: "key", key: "C" },
    );
    expect(result.state).toEqual({ level: "off" });
    expect(result.activate).toEqual({ target: "control:home/1" });
  });

  it("どのチップにも当たらないキーは、状態を変えない", () => {
    const result = step({ level: "tabs" }, { type: "key", key: "z" });
    expect(result.state).toEqual({ level: "tabs" });
    expect(result.activate).toBeUndefined();
  });

  it("Esc で 1 段戻り、もう一度で閉じる", () => {
    const s1 = step({ level: "controls", tab: "home" }, { type: "escape" });
    expect(s1.state).toEqual({ level: "tabs" });
    expect(step(s1.state, { type: "escape" }).state).toEqual({ level: "off" });
    expect(step({ level: "off" }, { type: "escape" }).state).toEqual({
      level: "off",
    });
  });

  it("閉じているときのキーは無視する", () => {
    const result = step({ level: "off" }, { type: "key", key: "h" });
    expect(result.state).toEqual({ level: "off" });
    expect(result.activate).toBeUndefined();
  });
});

describe("Alt の単独押し（tap）の検出", () => {
  it("Alt を押して、他のキーなしで離すと tap", () => {
    const d = createAltTapDetector();
    expect(d.keydown("Alt")).toBe(false);
    expect(d.keyup("Alt")).toBe(true);
  });

  it("間に他のキーを押したら、tap ではない", () => {
    const d = createAltTapDetector();
    d.keydown("Alt");
    d.keydown("x");
    expect(d.keyup("Alt")).toBe(false);
  });

  it("キーの自動連打（repeat）は、1 回として数える", () => {
    const d = createAltTapDetector();
    d.keydown("Alt");
    d.keydown("Alt");
    d.keydown("Alt");
    expect(d.keyup("Alt")).toBe(true);
  });

  it("次の Alt は、新しく判定する", () => {
    const d = createAltTapDetector();
    d.keydown("Alt");
    d.keydown("x");
    d.keyup("Alt");
    d.keydown("Alt");
    expect(d.keyup("Alt")).toBe(true);
  });

  it("マウスの操作でも、tap を打ち消せる", () => {
    const d = createAltTapDetector();
    d.keydown("Alt");
    d.cancel();
    expect(d.keyup("Alt")).toBe(false);
  });
});
