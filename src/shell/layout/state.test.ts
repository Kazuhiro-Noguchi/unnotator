import { describe, expect, it, vi } from "vitest";
import { createContext } from "../when/context";
import {
  ACTIVITY_BAR_WIDTH,
  createLayoutStore,
  defaultLayout,
  EDITOR_MIN_HEIGHT,
  EDITOR_MIN_WIDTH,
  effectiveLayout,
  KNOWN_VIEWS,
  normalizeLayout,
} from "./state";

const viewport = { width: 1280, height: 800 };

describe("配置の既定値と補正", () => {
  it("既定値（data-model.md）", () => {
    expect(defaultLayout()).toEqual({
      version: 1,
      primarySidebar: { visible: true, width: 280, view: "explorer" },
      secondarySidebar: { visible: true, width: 300, tab: "info" },
      bottom: { visible: false, height: 220, tab: "output" },
    });
  });

  it("保存が無い・オブジェクトでないときは既定", () => {
    expect(normalizeLayout(undefined, viewport)).toEqual(defaultLayout());
    expect(normalizeLayout(null, viewport)).toEqual(defaultLayout());
    expect(normalizeLayout("x", viewport)).toEqual(defaultLayout());
    expect(normalizeLayout([], viewport)).toEqual(defaultLayout());
    expect(normalizeLayout({}, viewport)).toEqual(defaultLayout());
  });

  it("有効な値はそのまま読み、未知の項目は無視する", () => {
    const raw = {
      version: 1,
      primarySidebar: { visible: false, width: 320, view: "search", extra: 1 },
      secondarySidebar: { visible: true, width: 260, tab: "info" },
      bottom: { visible: true, height: 300, tab: "jobs" },
      statusBar: { visible: false }, // 以前の設定。ステータスバーは常に表示するので無視される
      unknown: true,
    };
    const result = normalizeLayout(raw, viewport);
    expect(result.primarySidebar).toEqual({
      visible: false,
      width: 320,
      view: "search",
    });
    expect(result.bottom).toEqual({ visible: true, height: 300, tab: "jobs" });
    expect(result).not.toHaveProperty("statusBar");
    expect(result).not.toHaveProperty("unknown");
  });

  it("範囲外・負数・小数・巨大な値・型違いは、既定か範囲内に直す", () => {
    const result = normalizeLayout(
      {
        primarySidebar: { visible: "yes", width: -5, view: 3 },
        secondarySidebar: { width: 99999, tab: "info" },
        bottom: { height: 12.7, tab: "output" },
      },
      { width: 4000, height: 3000 },
    );
    expect(result.primarySidebar.visible).toBe(true);
    expect(result.primarySidebar.width).toBe(280);
    expect(result.primarySidebar.view).toBe("explorer");
    expect(result.secondarySidebar.width).toBe(640);
    expect(result.bottom.height).toBe(120);
    expect(Number.isInteger(result.bottom.height)).toBe(true);
  });

  it("幅は 180〜640、高さは 120〜600 に収める", () => {
    const small = normalizeLayout(
      {
        primarySidebar: { width: 10 },
        secondarySidebar: { width: 10 },
        bottom: { height: 10 },
      },
      { width: 4000, height: 3000 },
    );
    expect(small.primarySidebar.width).toBe(180);
    expect(small.secondarySidebar.width).toBe(180);
    expect(small.bottom.height).toBe(120);
    const large = normalizeLayout(
      {
        primarySidebar: { width: 9999 },
        secondarySidebar: { width: 9999 },
        bottom: { height: 9999 },
      },
      { width: 4000, height: 3000 },
    );
    expect(large.primarySidebar.width).toBe(640);
    expect(large.bottom.height).toBe(600);
  });

  it("存在しない選択中のビューは、既定のビューに戻る", () => {
    const result = normalizeLayout(
      {
        primarySidebar: { view: "com.gone/view" },
        secondarySidebar: { tab: "com.gone/tab" },
        bottom: { tab: "com.gone/panel" },
      },
      viewport,
    );
    expect(result.primarySidebar.view).toBe("explorer");
    expect(result.secondarySidebar.tab).toBe("info");
    expect(result.bottom.tab).toBe("output");
  });

  it("追加で登録されたビューは、知っているものとして残る", () => {
    const result = normalizeLayout(
      { primarySidebar: { view: "com.x/view" } },
      viewport,
      {
        ...KNOWN_VIEWS,
        primarySidebar: [...KNOWN_VIEWS.primarySidebar, "com.x/view"],
      },
    );
    expect(result.primarySidebar.view).toBe("com.x/view");
  });

  it("モニターを替えて収まらない配置は、エディター領域の最小値を確保して縮める", () => {
    const result = normalizeLayout(
      {
        primarySidebar: { visible: true, width: 640 },
        secondarySidebar: { visible: true, width: 640 },
        bottom: { visible: true, height: 600 },
      },
      { width: 1000, height: 600 },
    );
    const used =
      ACTIVITY_BAR_WIDTH +
      (result.primarySidebar.visible ? result.primarySidebar.width : 0) +
      (result.secondarySidebar.visible ? result.secondarySidebar.width : 0);
    expect(1000 - used).toBeGreaterThanOrEqual(EDITOR_MIN_WIDTH);
  });
});

describe("effectiveLayout: ウィンドウが縮んだとき他の領域が先に縮む", () => {
  const wide = {
    version: 1 as const,
    primarySidebar: { visible: true, width: 400, view: "explorer" },
    secondarySidebar: { visible: true, width: 400, tab: "info" },
    bottom: { visible: true, height: 400, tab: "output" },
  };

  it("収まるなら、そのまま", () => {
    const result = effectiveLayout(wide, { width: 2000, height: 1200 });
    expect(result.primarySidebar.width).toBe(400);
    expect(result.secondarySidebar.width).toBe(400);
    expect(result.bottom.height).toBe(400);
  });

  it("収まらないなら、エディター領域が最小値を下回らない", () => {
    for (const width of [800, 900, 1000, 1100]) {
      const result = effectiveLayout(wide, { width, height: 500 });
      const used =
        ACTIVITY_BAR_WIDTH +
        result.primarySidebar.width +
        result.secondarySidebar.width;
      expect(width - used).toBeGreaterThanOrEqual(EDITOR_MIN_WIDTH);
      expect(result.bottom.height).toBeLessThanOrEqual(
        500 - 200 /* リボンなどの固定の高さ */ - EDITOR_MIN_HEIGHT + 100,
      );
    }
  });

  it("保存している好みの値は変えない（縮んだ表示だけが変わる）", () => {
    const copy = structuredClone(wide);
    effectiveLayout(wide, { width: 800, height: 500 });
    expect(wide).toEqual(copy);
  });

  it("縮むのは、プロパティ → サイドバーの順", () => {
    const result = effectiveLayout(wide, { width: 1000, height: 1200 });
    // 1000 - 48(アクティビティバー) - 320(エディター) = 632 が側面に使える
    expect(result.primarySidebar.width + result.secondarySidebar.width).toBe(
      632,
    );
    expect(result.primarySidebar.width).toBe(400);
    expect(result.secondarySidebar.width).toBe(232);
  });

  it("非表示の領域は幅に数えない", () => {
    const hidden = {
      ...wide,
      secondarySidebar: { ...wide.secondarySidebar, visible: false },
    };
    const result = effectiveLayout(hidden, { width: 1000, height: 1200 });
    expect(result.primarySidebar.width).toBe(400);
  });
});

describe("配置のストア", () => {
  function makeStore(initial = defaultLayout()) {
    const ctx = createContext();
    const save = vi.fn();
    const store = createLayoutStore({ initial, ctx, save });
    return { store, ctx, save };
  }

  it("領域の表示を切り替え、コンテキストに反映し、保存する", () => {
    const { store, ctx, save } = makeStore();
    expect(ctx.get("primarySidebarVisible")).toBe(true);
    store.toggle("primarySidebar");
    expect(store.get().primarySidebar.visible).toBe(false);
    expect(ctx.get("primarySidebarVisible")).toBe(false);
    store.toggle("bottom");
    expect(ctx.get("bottomVisible")).toBe(true);
    store.toggle("secondarySidebar");
    expect(ctx.get("secondarySidebarVisible")).toBe(false);
    expect(save).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenLastCalledWith(store.get());
  });

  it("アクティビティバーの入口を選ぶと切り替わり、再選択で閉じる", () => {
    const { store, ctx } = makeStore();
    store.selectPrimarySidebarView("search");
    expect(store.get().primarySidebar.view).toBe("search");
    expect(store.get().primarySidebar.visible).toBe(true);
    expect(ctx.get("primarySidebarView")).toBe("search");
    store.selectPrimarySidebarView("search");
    expect(store.get().primarySidebar.visible).toBe(false);
    store.selectPrimarySidebarView("search");
    expect(store.get().primarySidebar.visible).toBe(true);
    store.selectPrimarySidebarView("labels");
    expect(store.get().primarySidebar.view).toBe("labels");
    expect(store.get().primarySidebar.visible).toBe(true);
  });

  it("閉じているサイドバーで別の入口を選ぶと、開いてその入口になる", () => {
    const { store } = makeStore();
    store.toggle("primarySidebar");
    store.selectPrimarySidebarView("labels");
    expect(store.get().primarySidebar).toEqual({
      visible: true,
      width: 280,
      view: "labels",
    });
  });

  it("大きさを変えると範囲に収めて保存する", () => {
    const { store } = makeStore();
    store.setSize("primarySidebar", 5000);
    expect(store.get().primarySidebar.width).toBe(640);
    store.setSize("primarySidebar", 10);
    expect(store.get().primarySidebar.width).toBe(180);
    store.setSize("secondarySidebar", 333.6);
    expect(store.get().secondarySidebar.width).toBe(334);
    store.setSize("bottom", 250);
    expect(store.get().bottom.height).toBe(250);
  });

  it("ボトムパネルのタブを選ぶと、開く", () => {
    const { store } = makeStore();
    store.selectBottomTab("problems");
    expect(store.get().bottom).toMatchObject({
      visible: true,
      tab: "problems",
    });
  });

  it("replace は、保存せずに差し替えて、コンテキストと購読者に知らせる", () => {
    const { store, ctx, save } = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const next = defaultLayout();
    next.primarySidebar.visible = false;
    store.replace(next);
    expect(store.get().primarySidebar.visible).toBe(false);
    expect(ctx.get("primarySidebarVisible")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("購読者に変更を知らせる", () => {
    const { store } = makeStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.toggle("primarySidebar");
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    store.toggle("primarySidebar");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
