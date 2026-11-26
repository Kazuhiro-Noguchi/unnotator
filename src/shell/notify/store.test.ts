import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_DISMISS_MS, createNotifyStore, MAX_NOTIFICATIONS } from "./store";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("通知のストア", () => {
  it("info と warn は 5 秒で消え、error は閉じるまで残る", () => {
    const store = createNotifyStore();
    store.notify("info", "i");
    store.notify("warn", "w");
    store.notify("error", "e");
    expect(AUTO_DISMISS_MS).toBe(5000);
    expect(store.list().map((n) => [n.level, n.autoDismissMs])).toEqual([
      ["info", 5000],
      ["warn", 5000],
      ["error", null],
    ]);
    vi.advanceTimersByTime(4999);
    expect(store.list()).toHaveLength(3);
    vi.advanceTimersByTime(2);
    expect(store.list().map((n) => n.level)).toEqual(["error"]);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(store.list().map((n) => n.level)).toEqual(["error"]);
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

  it("同時に 5 件まで。超えたら、古い info / warn から消える", () => {
    const store = createNotifyStore();
    expect(MAX_NOTIFICATIONS).toBe(5);
    store.notify("error", "e1");
    store.notify("info", "i1");
    store.notify("warn", "w1");
    store.notify("error", "e2");
    store.notify("info", "i2");
    store.notify("info", "i3");
    expect(store.list().map((n) => n.text)).toEqual([
      "e1",
      "w1",
      "e2",
      "i2",
      "i3",
    ]);
  });

  it("全部が error なら、いちばん古い error が消える", () => {
    const store = createNotifyStore();
    for (let i = 1; i <= 6; i++) store.notify("error", `e${i}`);
    expect(store.list().map((n) => n.text)).toEqual([
      "e2",
      "e3",
      "e4",
      "e5",
      "e6",
    ]);
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
