import { describe, expect, it } from "vitest";
import { createContext } from "../when/context";
import { createLayoutStore, defaultLayout } from "./state";
import { resolveTab } from "./tabs";

describe("パネルのタブの選択", () => {
  it("選んだタブが無ければ、既定のタブに戻る", () => {
    expect(resolveTab("jobs", ["output", "jobs", "problems"], "output")).toBe(
      "jobs",
    );
    expect(resolveTab("com.gone/x", ["output", "jobs"], "output")).toBe(
      "output",
    );
  });

  it("既定のタブも無ければ、先頭。何も無ければ null", () => {
    expect(resolveTab("a", ["b", "c"], "zzz")).toBe("b");
    expect(resolveTab("a", [], "output")).toBeNull();
  });

  it("ボトムパネルのタブの選択が、配置に保存される", () => {
    const saved: unknown[] = [];
    const store = createLayoutStore({
      initial: defaultLayout(),
      ctx: createContext(),
      save: (layout) => saved.push(layout.bottom.tab),
    });
    store.selectBottomTab("jobs");
    store.selectBottomTab("problems");
    expect(store.get().bottom).toMatchObject({
      tab: "problems",
      visible: true,
    });
    expect(saved).toEqual(["jobs", "problems"]);
  });

  it("プロパティパネルの追加タブも、選択が保存される", () => {
    const store = createLayoutStore({
      initial: defaultLayout(),
      ctx: createContext(),
      save: () => {},
    });
    store.selectSecondarySidebarTab("com.x/extra");
    expect(store.get().secondarySidebar.tab).toBe("com.x/extra");
  });
});
