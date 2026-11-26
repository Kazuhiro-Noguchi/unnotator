import { describe, expect, it, vi } from "vitest";
import { createSettingsPages } from "./pages";

const render = () => null as never;

describe("設定画面のページ登録（カテゴリのツリー）", () => {
  it("カテゴリの下にページが並ぶ（order の昇順、同じなら登録順）", () => {
    const pages = createSettingsPages();
    pages.addCategory({
      id: "general",
      title: { ja: "一般" },
      order: 10,
      source: "core",
    });
    pages.addCategory({
      id: "project",
      title: { ja: "プロジェクト" },
      order: 20,
      source: "core",
    });
    pages.addPage({
      id: "keys",
      category: "general",
      title: { ja: "キー" },
      order: 20,
      render,
      source: "core",
    });
    pages.addPage({
      id: "look",
      category: "general",
      title: { ja: "外観" },
      order: 10,
      render,
      source: "core",
    });
    pages.addPage({
      id: "assets",
      category: "project",
      title: { ja: "アセット" },
      render,
      source: "core",
    });
    const tree = pages.tree();
    expect(tree.map((c) => c.id)).toEqual(["general", "project"]);
    expect(tree[0]?.pages.map((p) => p.id)).toEqual(["look", "keys"]);
    expect(tree[1]?.pages.map((p) => p.id)).toEqual(["assets"]);
  });

  it("ページの無いカテゴリは、ツリーに出さない", () => {
    const pages = createSettingsPages();
    pages.addCategory({ id: "empty", title: { ja: "空" }, source: "core" });
    expect(pages.tree()).toEqual([]);
  });

  it("存在しないカテゴリを指すページは、「その他」に入れる", () => {
    const pages = createSettingsPages();
    pages.addPage({
      id: "x",
      category: "nope",
      title: { ja: "X" },
      render,
      source: "com.x",
    });
    const tree = pages.tree();
    expect(tree).toHaveLength(1);
    expect(tree[0]?.id).toBe("other");
    expect(tree[0]?.pages.map((p) => p.id)).toEqual(["x"]);
  });

  it("同じ ID のページは、先に登録したものを残す", () => {
    const pages = createSettingsPages();
    pages.addCategory({ id: "g", title: { ja: "G" }, source: "core" });
    pages.addPage({
      id: "p",
      category: "g",
      title: { ja: "先" },
      render,
      source: "core",
    });
    pages.addPage({
      id: "p",
      category: "g",
      title: { ja: "後" },
      render,
      source: "core",
    });
    expect(pages.tree()[0]?.pages).toHaveLength(1);
    expect(pages.tree()[0]?.pages[0]?.title).toEqual({ ja: "先" });
  });

  it("removeSource で、その追加元のページ・カテゴリが消える", () => {
    const pages = createSettingsPages();
    pages.addCategory({ id: "g", title: { ja: "G" }, source: "core" });
    pages.addPage({
      id: "a",
      category: "g",
      title: { ja: "A" },
      render,
      source: "core",
    });
    pages.addPage({
      id: "b",
      category: "g",
      title: { ja: "B" },
      render,
      source: "com.x",
    });
    pages.removeSource("com.x");
    expect(pages.tree()[0]?.pages.map((p) => p.id)).toEqual(["a"]);
  });

  it("find でページを引け、変更を購読できる", () => {
    const pages = createSettingsPages();
    const listener = vi.fn();
    pages.subscribe(listener);
    pages.addCategory({ id: "g", title: { ja: "G" }, source: "core" });
    pages.addPage({
      id: "a",
      category: "g",
      title: { ja: "A" },
      render,
      source: "core",
    });
    expect(pages.find("a")?.id).toBe("a");
    expect(pages.find("zzz")).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
