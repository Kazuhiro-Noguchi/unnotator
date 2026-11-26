import { describe, expect, it, vi } from "vitest";
import { createStatusStore } from "./store";

describe("ステータスバーのストア", () => {
  it("初期状態: メッセージなし・進捗なし・ジョブ 0", () => {
    const store = createStatusStore();
    expect(store.state()).toEqual({ message: null, progress: null, jobs: 0 });
    expect(store.items("left")).toEqual([]);
    expect(store.items("right")).toEqual([]);
  });

  it("メッセージ・進捗・ジョブ数を設定し、消せる", () => {
    const store = createStatusStore();
    store.setMessage("読み込み中");
    store.setProgress({ done: 12, total: 340 });
    store.setJobs(2);
    expect(store.state()).toEqual({
      message: "読み込み中",
      progress: { done: 12, total: 340 },
      jobs: 2,
    });
    store.setMessage(null);
    store.setProgress(null);
    store.setJobs(0);
    expect(store.state()).toEqual({ message: null, progress: null, jobs: 0 });
  });

  it("進捗の割合（整数の %）を返す。総数 0・不正な値は進捗なし扱い", () => {
    const store = createStatusStore();
    store.setProgress({ done: 12, total: 340 });
    expect(store.percent()).toBe(4);
    store.setProgress({ done: 340, total: 340 });
    expect(store.percent()).toBe(100);
    store.setProgress({ done: 0, total: 0 });
    expect(store.state().progress).toBeNull();
    expect(store.percent()).toBeNull();
    store.setProgress({ done: -1, total: 5 });
    expect(store.state().progress).toBeNull();
    store.setProgress({ done: 9, total: 5 });
    expect(store.state().progress).toEqual({ done: 5, total: 5 });
    store.setJobs(-3);
    expect(store.state().jobs).toBe(0);
  });

  it("送り元ごとの項目を、位置（left / right）と priority（大きいほど端に近い）で並べる", () => {
    const store = createStatusStore();
    const base = { alignment: "left" as const };
    store.setItem(
      { source: "a", id: "1", priority: 0, text: "a1", ...base },
      { source: "a", id: "1" },
    );
    store.setItem(
      { source: "b", id: "1", priority: 10, text: "b1", ...base },
      { source: "b", id: "1" },
    );
    store.setItem(
      { source: "a", id: "2", priority: 0, text: "a2", ...base },
      { source: "a", id: "2" },
    );
    store.setItem(
      { source: "a", id: "3", priority: 0, text: "r", alignment: "right" },
      { source: "a", id: "3" },
    );
    expect(store.items("left").map((i) => i.text)).toEqual(["b1", "a1", "a2"]);
    expect(store.items("right").map((i) => i.text)).toEqual(["r"]);
  });

  it("同じ（送り元・id）の項目は、置き換わる。null で消える", () => {
    const store = createStatusStore();
    const key = { source: "a", id: "1" };
    store.setItem({ ...key, alignment: "left", priority: 0, text: "old" }, key);
    store.setItem({ ...key, alignment: "left", priority: 0, text: "new" }, key);
    expect(store.items("left").map((i) => i.text)).toEqual(["new"]);
    store.setItem(null, key);
    expect(store.items("left")).toEqual([]);
  });

  it("removeSource で、その送り元の項目がすべて消える", () => {
    const store = createStatusStore();
    store.setItem(
      { source: "a", id: "1", alignment: "left", priority: 0, text: "x" },
      { source: "a", id: "1" },
    );
    store.setItem(
      { source: "a", id: "2", alignment: "right", priority: 0, text: "y" },
      { source: "a", id: "2" },
    );
    store.setItem(
      { source: "b", id: "1", alignment: "left", priority: 0, text: "z" },
      { source: "b", id: "1" },
    );
    store.removeSource("a");
    expect(store.items("left").map((i) => i.text)).toEqual(["z"]);
    expect(store.items("right")).toEqual([]);
  });

  it("変更を購読できる", () => {
    const store = createStatusStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.setMessage("a");
    store.setJobs(1);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    store.setMessage("b");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
