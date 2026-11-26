import { describe, expect, it, vi } from "vitest";
import { CORE_CONTEXT_KEYS, createContext } from "./context";

describe("コンテキスト", () => {
  it("未設定のキーは null", () => {
    const ctx = createContext();
    expect(ctx.get("nothing")).toBeNull();
  });

  it("set した値を get できる", () => {
    const ctx = createContext();
    ctx.set("a", true);
    ctx.set("b", "x");
    ctx.set("c", 3);
    expect(ctx.get("a")).toBe(true);
    expect(ctx.get("b")).toBe("x");
    expect(ctx.get("c")).toBe(3);
  });

  it("null を set するとキーが未設定に戻る", () => {
    const ctx = createContext();
    ctx.set("a", true);
    ctx.set("a", null);
    expect(ctx.get("a")).toBeNull();
  });

  it("watch は、読んだキーが変わったときだけ onChange を呼ぶ", () => {
    const ctx = createContext();
    ctx.set("a", false);
    ctx.set("b", false);
    const onChange = vi.fn();
    const w = ctx.watch(() => ctx.get("a") === true, onChange);
    expect(w.value).toBe(false);
    ctx.set("b", true);
    expect(onChange).not.toHaveBeenCalled();
    ctx.set("a", true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(w.value).toBe(true);
  });

  it("watch は、計算結果が変わらないときは onChange を呼ばない", () => {
    const ctx = createContext();
    ctx.set("n", 1);
    const onChange = vi.fn();
    ctx.watch(() => (ctx.get("n") as number) > 0, onChange);
    ctx.set("n", 2);
    expect(onChange).not.toHaveBeenCalled();
    ctx.set("n", 0);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("watch は、条件分岐で読むキーが変わっても追跡し直す", () => {
    const ctx = createContext();
    ctx.set("mode", "a");
    ctx.set("a", 1);
    ctx.set("b", 10);
    const seen: unknown[] = [];
    ctx.watch(
      () => (ctx.get("mode") === "a" ? ctx.get("a") : ctx.get("b")),
      (v) => seen.push(v),
    );
    ctx.set("b", 11); // まだ読んでいない
    expect(seen).toEqual([]);
    ctx.set("mode", "b");
    expect(seen).toEqual([11]);
    ctx.set("b", 12);
    expect(seen).toEqual([11, 12]);
    ctx.set("a", 2); // もう読んでいない
    expect(seen).toEqual([11, 12]);
  });

  it("dispose した watch は呼ばれない", () => {
    const ctx = createContext();
    const onChange = vi.fn();
    const w = ctx.watch(() => ctx.get("a"), onChange);
    w.dispose();
    ctx.set("a", 1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("setNamespaced は <owner>.<key> として保存する", () => {
    const ctx = createContext();
    ctx.setNamespaced("com.example.x", "ready", true);
    expect(ctx.get("com.example.x.ready")).toBe(true);
  });

  it("remove(owner) は、その名前空間のキーだけを消す", () => {
    const ctx = createContext();
    ctx.setNamespaced("com.example.x", "a", 1);
    ctx.setNamespaced("com.example.x", "b", 2);
    ctx.setNamespaced("com.example.y", "a", 3);
    ctx.set("projectOpen", true);
    const onChange = vi.fn();
    ctx.watch(() => ctx.get("com.example.x.a"), onChange);
    ctx.remove("com.example.x");
    expect(ctx.get("com.example.x.a")).toBeNull();
    expect(ctx.get("com.example.x.b")).toBeNull();
    expect(ctx.get("com.example.y.a")).toBe(3);
    expect(ctx.get("projectOpen")).toBe(true);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("owner が別の owner の接頭辞でも、巻き込まない", () => {
    const ctx = createContext();
    ctx.setNamespaced("com.example", "a", 1);
    ctx.setNamespaced("com.example.longer", "a", 2);
    ctx.remove("com.example");
    expect(ctx.get("com.example.longer.a")).toBe(2);
  });

  it("コアのキーが、設計書どおりそろっていて、初期値が入っている", () => {
    expect([...CORE_CONTEXT_KEYS].sort()).toEqual(
      [
        "projectOpen",
        "projectDirty",
        "canUndo",
        "canRedo",
        "focusRegion",
        "inputFocus",
        "theme",
        "language",
        "primarySidebarVisible",
        "secondarySidebarVisible",
        "bottomVisible",
        "primarySidebarView",
        "hasCurrent",
        "filterActive",
      ].sort(),
    );
    const ctx = createContext();
    for (const key of CORE_CONTEXT_KEYS) {
      expect(ctx.get(key)).not.toBeUndefined();
    }
    expect(ctx.get("projectOpen")).toBe(false);
    expect(ctx.get("inputFocus")).toBe(false);
  });
});
