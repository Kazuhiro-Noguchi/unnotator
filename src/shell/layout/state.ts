// 画面の配置（specs/006-shell-layout/data-model.md の LayoutState、research.md R9）。
import type { Context, LayoutState } from "../types";

export const ACTIVITY_BAR_WIDTH = 48;
export const EDITOR_MIN_WIDTH = 320;
export const EDITOR_MIN_HEIGHT = 200;
/** タイトルバー・リボン・ステータスバーなど、固定の高さの合計の目安。 */
export const CHROME_HEIGHT = 176;
export const SIDE_WIDTH_RANGE = { min: 180, max: 640 } as const;
export const BOTTOM_HEIGHT_RANGE = { min: 120, max: 600 } as const;

export interface Viewport {
  width: number;
  height: number;
}

export interface KnownViews {
  primarySidebar: string[];
  secondarySidebar: string[];
  bottom: string[];
}

export const KNOWN_VIEWS: KnownViews = {
  primarySidebar: ["explorer", "labels", "search", "extensions"],
  secondarySidebar: ["info"],
  bottom: ["output", "jobs", "problems"],
};

export function defaultLayout(): LayoutState {
  return {
    version: 1,
    primarySidebar: { visible: true, width: 280, view: "explorer" },
    secondarySidebar: { visible: true, width: 300, tab: "info" },
    bottom: { visible: false, height: 220, tab: "output" },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function size(
  value: unknown,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return clamp(Math.round(value), range.min, range.max);
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function choice(value: unknown, known: string[], fallback: string): string {
  return typeof value === "string" && known.includes(value) ? value : fallback;
}

/**
 * ウィンドウの大きさに合わせた「表示上の」配置。エディター領域の最小の大きさを守るため、
 * プロパティ → サイドバーの順に、ボトムパネルは高さを縮める。保存している値は変えない。
 */
export function effectiveLayout(
  layout: LayoutState,
  viewport: Viewport,
): LayoutState {
  const result = structuredClone(layout);
  const sideRoom = Math.max(
    0,
    viewport.width - ACTIVITY_BAR_WIDTH - EDITOR_MIN_WIDTH,
  );
  let sidebar = layout.primarySidebar.visible ? layout.primarySidebar.width : 0;
  let properties = layout.secondarySidebar.visible
    ? layout.secondarySidebar.width
    : 0;
  let excess = sidebar + properties - sideRoom;
  if (excess > 0) {
    const cut = Math.min(properties, excess);
    properties -= cut;
    excess -= cut;
    sidebar = Math.max(0, sidebar - excess);
  }
  if (layout.primarySidebar.visible) result.primarySidebar.width = sidebar;
  if (layout.secondarySidebar.visible)
    result.secondarySidebar.width = properties;
  if (layout.bottom.visible) {
    const room = Math.max(
      0,
      viewport.height - CHROME_HEIGHT - EDITOR_MIN_HEIGHT,
    );
    result.bottom.height = Math.min(layout.bottom.height, room);
  }
  return result;
}

/** 保存された値を読み、補正する。未知の項目は無視し、収まらない大きさは縮める。 */
export function normalizeLayout(
  raw: unknown,
  viewport: Viewport,
  known: KnownViews = KNOWN_VIEWS,
): LayoutState {
  const base = defaultLayout();
  if (!isRecord(raw)) return base;
  const sidebar = isRecord(raw.primarySidebar) ? raw.primarySidebar : {};
  const properties = isRecord(raw.secondarySidebar) ? raw.secondarySidebar : {};
  const bottom = isRecord(raw.bottom) ? raw.bottom : {};
  const loaded: LayoutState = {
    version: 1,
    primarySidebar: {
      visible: flag(sidebar.visible, base.primarySidebar.visible),
      width: size(sidebar.width, base.primarySidebar.width, SIDE_WIDTH_RANGE),
      view: choice(
        sidebar.view,
        known.primarySidebar,
        base.primarySidebar.view,
      ),
    },
    secondarySidebar: {
      visible: flag(properties.visible, base.secondarySidebar.visible),
      width: size(
        properties.width,
        base.secondarySidebar.width,
        SIDE_WIDTH_RANGE,
      ),
      tab: choice(
        properties.tab,
        known.secondarySidebar,
        base.secondarySidebar.tab,
      ),
    },
    bottom: {
      visible: flag(bottom.visible, base.bottom.visible),
      height: size(bottom.height, base.bottom.height, BOTTOM_HEIGHT_RANGE),
      tab: choice(bottom.tab, known.bottom, base.bottom.tab),
    },
  };
  return effectiveLayout(loaded, viewport);
}

export type Region = "primarySidebar" | "secondarySidebar" | "bottom";

export interface LayoutStoreDeps {
  initial: LayoutState;
  ctx: Context;
  save: (layout: LayoutState) => void;
}

export function createLayoutStore({ initial, ctx, save }: LayoutStoreDeps) {
  let state = structuredClone(initial);
  const listeners = new Set<() => void>();

  function publish(): void {
    ctx.set("primarySidebarVisible", state.primarySidebar.visible);
    ctx.set("secondarySidebarVisible", state.secondarySidebar.visible);
    ctx.set("bottomVisible", state.bottom.visible);
    ctx.set("primarySidebarView", state.primarySidebar.view);
  }

  function commit(next: LayoutState): void {
    state = next;
    publish();
    save(structuredClone(state));
    for (const listener of [...listeners]) listener();
  }

  publish();

  return {
    get: (): LayoutState => state,
    /** 読み込んだ設定で差し替える（保存はしない）。 */
    replace(next: LayoutState): void {
      state = structuredClone(next);
      publish();
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle(region: Region): void {
      const next = structuredClone(state);
      next[region].visible = !next[region].visible;
      commit(next);
    },
    /** アクティビティバーの入口。選択中の入口をもう一度選ぶと閉じる。 */
    selectPrimarySidebarView(view: string): void {
      const next = structuredClone(state);
      if (next.primarySidebar.visible && next.primarySidebar.view === view) {
        next.primarySidebar.visible = false;
      } else {
        next.primarySidebar.view = view;
        next.primarySidebar.visible = true;
      }
      commit(next);
    },
    selectBottomTab(tab: string): void {
      const next = structuredClone(state);
      next.bottom.tab = tab;
      next.bottom.visible = true;
      commit(next);
    },
    selectSecondarySidebarTab(tab: string): void {
      const next = structuredClone(state);
      next.secondarySidebar.tab = tab;
      commit(next);
    },
    setSize(
      region: "primarySidebar" | "secondarySidebar" | "bottom",
      value: number,
    ): void {
      const next = structuredClone(state);
      if (region === "bottom") {
        next.bottom.height = clamp(
          Math.round(value),
          BOTTOM_HEIGHT_RANGE.min,
          BOTTOM_HEIGHT_RANGE.max,
        );
      } else {
        next[region].width = clamp(
          Math.round(value),
          SIDE_WIDTH_RANGE.min,
          SIDE_WIDTH_RANGE.max,
        );
      }
      commit(next);
    },
  };
}
