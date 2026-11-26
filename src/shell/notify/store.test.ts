import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_DISMISS_MS,
  createNotifyStore,
  HISTORY_LIMIT,
  VISIBLE_NOTIFICATIONS,
} from "./store";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("通知のストア: 送り元と操作", () => {
  it("送り元・操作・設定の入口を、通知に持たせる", () => {
    const store = createNotifyStore();
    const run = vi.fn();
    const settings = vi.fn();
    store.notify("info", "リポジトリが見つかりました", {
      source: "Git",
      actions: [
        { label: "はい", primary: true, run },
        { label: "いつも", run },
      ],
      settings,
    });
    const item = store.list()[0];
    expect(item?.source).toBe("Git");
    expect(item?.actions?.map((a) => [a.label, a.primary === true])).toEqual([
      ["はい", true],
      ["いつも", false],
    ]);
    expect(item?.settings).toBe(settings);
  });

  it("操作のある通知は、info・warn でも、自動で消えない", () => {
    const store = createNotifyStore();
    store.notify("info", "選んでください", {
      actions: [{ label: "OK", run: vi.fn() }],
    });
    store.notify("warn", "選んでください", {
      actions: [{ label: "OK", run: vi.fn() }],
    });
    expect(store.list().map((n) => n.autoDismissMs)).toEqual([null, null]);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(store.list()).toHaveLength(2);
  });

  it("操作を空の配列にすれば、ふつうの通知と同じ", () => {
    const store = createNotifyStore();
    store.notify("info", "a", { actions: [] });
    expect(store.list()[0]?.autoDismissMs).toBe(5000);
  });

  it("run を呼んで、通知を閉じられる（部品が dismiss と組み合わせる）", () => {
    const store = createNotifyStore();
    const run = vi.fn();
    const id = store.notify("info", "a", { actions: [{ label: "OK", run }] });
    store.list()[0]?.actions?.[0]?.run();
    store.dismiss(id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.list()).toEqual([]);
  });
});

describe("通知のストア", () => {
  it("info は 5 秒で消え、warn と error は閉じるまで残る", () => {
    const store = createNotifyStore();
    store.notify("info", "i");
    store.notify("warn", "w");
    store.notify("error", "e");
    expect(AUTO_DISMISS_MS).toBe(5000);
    expect(store.list().map((n) => [n.level, n.autoDismissMs])).toEqual([
      ["info", 5000],
      ["warn", null],
      ["error", null],
    ]);
    vi.advanceTimersByTime(4999);
    expect(store.list()).toHaveLength(3);
    vi.advanceTimersByTime(2);
    expect(store.list().map((n) => n.level)).toEqual(["warn", "error"]);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(store.list().map((n) => n.level)).toEqual(["warn", "error"]);
  });

  it("id は連番で、dismiss で消える", () => {
    const store = createNotifyStore();
    const a = store.notify("error", "a");
    const b = store.notify("error", "b");
    expect(b).toBe(a + 1);
    store.dismiss(a);
    expect(store.list().map((n) => n.text)).toEqual(["b"]);
    store.dismiss(999);
    expect(store.list()).toHaveLength(1);
  });

  it("溜まっても、古い通知を勝手に消さない", () => {
    const store = createNotifyStore();
    expect(VISIBLE_NOTIFICATIONS).toBe(3);
    for (let i = 1; i <= 10; i++)
      store.notify(i % 2 ? "error" : "warn", `n${i}`);
    expect(store.history()).toHaveLength(10);
    expect(store.history()[0]?.text).toBe("n1");
  });

  it("clear で、すべて閉じる（自動で消えるタイマーも止まる）", () => {
    const store = createNotifyStore();
    const listener = vi.fn();
    store.notify("info", "i");
    store.notify("error", "e");
    store.subscribe(listener);
    store.clear();
    expect(store.list()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    store.clear();
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10000);
    expect(store.list()).toEqual([]);
  });

  it("消えたあとのタイマーが、別の通知を消さない", () => {
    const store = createNotifyStore();
    const a = store.notify("info", "a");
    store.dismiss(a);
    vi.advanceTimersByTime(3000);
    store.notify("info", "b");
    vi.advanceTimersByTime(2500);
    expect(store.list().map((n) => n.text)).toEqual(["b"]);
  });

  it("購読者に変更を知らせる", () => {
    const store = createNotifyStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    const id = store.notify("error", "x");
    store.dismiss(id);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    store.notify("error", "y");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("通知センター（しまってある全部）", () => {
  it("トーストから消えても、history には残る", () => {
    const store = createNotifyStore();
    const info = store.notify("info", "i");
    const warn = store.notify("warn", "w");
    vi.advanceTimersByTime(AUTO_DISMISS_MS + 1);
    expect(store.list().map((n) => n.id)).toEqual([warn]);
    expect(store.history().map((n) => n.id)).toEqual([info, warn]);
    store.dismiss(warn);
    expect(store.list()).toEqual([]);
    expect(store.history()).toHaveLength(2);
  });

  it("clear はトーストだけ、removeAll は全部を消す", () => {
    const store = createNotifyStore();
    store.notify("error", "a");
    store.notify("error", "b");
    store.clear();
    expect(store.list()).toEqual([]);
    expect(store.history()).toHaveLength(2);
    store.removeAll();
    expect(store.history()).toEqual([]);
  });

  it("remove で、1 件だけ通知センターからも消える", () => {
    const store = createNotifyStore();
    const a = store.notify("error", "a");
    store.notify("error", "b");
    store.remove(a);
    expect(store.list().map((n) => n.text)).toEqual(["b"]);
    expect(store.history().map((n) => n.text)).toEqual(["b"]);
  });

  it(`${HISTORY_LIMIT} 件を超えたら、古いものから消える`, () => {
    const store = createNotifyStore();
    for (let i = 1; i <= HISTORY_LIMIT + 2; i++) store.notify("error", `n${i}`);
    expect(store.history()).toHaveLength(HISTORY_LIMIT);
    expect(store.history()[0]?.text).toBe("n3");
  });
});

describe("トーストの出し方", () => {
  it("同時に 3 件まで。4 件目が来ると、いちばん古いトーストが消える（通知センターには残る）", () => {
    const store = createNotifyStore();
    for (let i = 1; i <= 4; i++) store.notify("error", `n${i}`);
    expect(store.list().map((n) => n.text)).toEqual(["n2", "n3", "n4"]);
    expect(store.history()).toHaveLength(4);
    store.dismiss(store.list()[2]?.id ?? 0);
    expect(store.list().map((n) => n.text)).toEqual(["n2", "n3"]);
  });

  it("通知センターを開く（setToastsEnabled(false)）と、トーストが消える", () => {
    const store = createNotifyStore();
    store.notify("error", "a");
    store.notify("warn", "b");
    store.setToastsEnabled(false);
    expect(store.list()).toEqual([]);
    expect(store.history()).toHaveLength(2);
  });

  it("開いている間の新しい通知は、トーストにせず、通知センターの末尾に入る", () => {
    const store = createNotifyStore();
    store.setToastsEnabled(false);
    store.notify("info", "新しい");
    expect(store.list()).toEqual([]);
    expect(store.history().map((n) => n.text)).toEqual(["新しい"]);
    vi.advanceTimersByTime(10000);
    store.setToastsEnabled(true);
    expect(store.list()).toEqual([]);
    store.notify("error", "閉じたあと");
    expect(store.list().map((n) => n.text)).toEqual(["閉じたあと"]);
  });
});
