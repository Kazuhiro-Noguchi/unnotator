import { describe, expect, it } from "vitest";
import { createDraftStore } from "./draft";

describe("DraftStore（入力途中の値）", () => {
  it("編集すると、その位置の下書きになる。元の値に戻すと、下書きではなくなる", () => {
    const d = createDraftStore();
    d.switchTo("a1");
    d.edit("note", "", "メモ");
    expect(d.dirty()).toBe(true);
    expect(d.valueOf("note")).toBe("メモ");
    d.edit("note", "", "");
    expect(d.dirty()).toBe(false);
    expect(d.valueOf("note")).toBeUndefined();
  });

  it("同じ位置への切り替えは、何も変えない", () => {
    const d = createDraftStore();
    d.switchTo("a1");
    d.edit("note", "", "x");
    expect(d.switchTo("a1")).toBe("same");
    expect(d.dirty()).toBe(true);
    expect(d.pending()).toBeNull();
  });

  it("下書きが無ければ、黙って切り替わる", () => {
    const d = createDraftStore();
    d.switchTo("a1");
    expect(d.switchTo("a2")).toBe("clean");
    expect(d.pending()).toBeNull();
  });

  it("下書きがあるまま別の位置に移ると、黙って失わず、保留にする", () => {
    const d = createDraftStore();
    d.switchTo("a1");
    d.edit("note", "", "x");
    d.edit("k", "1", "2");
    expect(d.switchTo("a2")).toBe("pending");
    const pending = d.pending();
    expect(pending?.targetKey).toBe("a1");
    expect(pending?.fields).toEqual([
      { field: "note", original: "", value: "x" },
      { field: "k", original: "1", value: "2" },
    ]);
    // 新しい位置の編集は、まっさらから始まる
    expect(d.dirty()).toBe(false);
    expect(d.valueOf("note")).toBeUndefined();
  });

  it("保留を確定すると、元の位置と内容が返り、保留は消える", () => {
    const d = createDraftStore();
    d.switchTo("a1");
    d.edit("note", "", "x");
    d.switchTo("a2");
    const resolved = d.resolvePending("apply");
    expect(resolved?.targetKey).toBe("a1");
    expect(resolved?.fields).toHaveLength(1);
    expect(d.pending()).toBeNull();
  });

  it("保留を破棄すると、何も返らず、保留は消える", () => {
    const d = createDraftStore();
    d.switchTo("a1");
    d.edit("note", "", "x");
    d.switchTo("a2");
    expect(d.resolvePending("discard")).toBeNull();
    expect(d.pending()).toBeNull();
  });

  it("保留があるうちにさらに移ると、保留は上書きされず、古い順に積まれる", () => {
    const d = createDraftStore();
    d.switchTo("a1");
    d.edit("note", "", "x");
    d.switchTo("a2");
    d.edit("note", "", "y");
    d.switchTo("a3");
    // 保留は古い順。先に a1、次に a2 を片づける
    expect(d.pending()?.targetKey).toBe("a1");
    expect(d.resolvePending("discard")).toBeNull();
    expect(d.pending()?.targetKey).toBe("a2");
  });

  it("確定（commit）したら、その位置の下書きを消す", () => {
    const d = createDraftStore();
    d.switchTo("a1");
    d.edit("note", "", "x");
    d.committed("note");
    expect(d.dirty()).toBe(false);
  });

  it("変更を購読できる", () => {
    const d = createDraftStore();
    let n = 0;
    d.subscribe(() => {
      n += 1;
    });
    d.switchTo("a1");
    d.edit("note", "", "x");
    expect(n).toBeGreaterThan(0);
  });
});
