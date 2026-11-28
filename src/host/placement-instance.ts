// アプリで使う画面の配置（1 つだけ）。拡張機能ホストの一覧から画面の宣言を集め、枠の入れ物を作る。
import {
  collectSurfaces,
  createPlacement,
  type EditorPreferences,
  type Surfaces,
} from "./placement";
import {
  createSurfaceOpener,
  observeThemeAttribute,
  readThemeVariables,
} from "./placement-frame";
import type { ExtensionHost, ExtensionInfo } from "./service";

function base(): string {
  // `instance.ts` と同じ規則（Windows の WebView2 は `http://unno.localhost/...`）。
  return navigator.userAgent.includes("Windows")
    ? "http://unno.localhost"
    : "unno://localhost";
}

/**
 * 既定のエディター（媒体種別 → エディター）の保存先。いまはセッションの間だけ持つ。
 * プロジェクト設定への保存は、コアの設定キーを足したあとに結ぶ（`EditorPreferences` を差し替える）。
 */
export function createMemoryPreferences(): EditorPreferences {
  const map = new Map<string, string>();
  return {
    get: (mediaType) => map.get(mediaType),
    set: (mediaType, editorId) => void map.set(mediaType, editorId),
  };
}

function displayName(infos: readonly ExtensionInfo[], id: string): string {
  const info = infos.find((i) => i.id === id);
  if (info?.manifest == null) return id;
  try {
    const manifest = JSON.parse(info.manifest) as { name?: unknown };
    return typeof manifest.name === "string" && manifest.name !== ""
      ? manifest.name
      : id;
  } catch {
    return id;
  }
}

/** 画面の宣言の同一性（変わったときだけ、開いている画面を選び直す）。 */
export function surfacesSignature(surfaces: Surfaces): string {
  return JSON.stringify(surfaces);
}

export function createPlacementRuntime(
  host: ExtensionHost,
  options: { preferences?: EditorPreferences } = {},
) {
  let surfaces: Surfaces = collectSurfaces(host.infos());
  let signature = surfacesSignature(surfaces);
  const listeners = new Set<(previous: Surfaces, next: Surfaces) => void>();

  const placement = createPlacement({
    surfaces: () => surfaces,
    preferences: options.preferences ?? createMemoryPreferences(),
  });
  const opener = createSurfaceOpener({
    frames: host.frames,
    base: base(),
    locale: () => document.documentElement.lang || "ja",
    versionOf: (id) => host.manager.versionOf(id),
    themeVariables: () => readThemeVariables(document),
    observeTheme: (listener) => observeThemeAttribute(document, listener),
  });

  host.onDidRefresh((infos) => {
    const next = collectSurfaces(infos);
    const nextSignature = surfacesSignature(next);
    if (nextSignature === signature) return;
    const previous = surfaces;
    surfaces = next;
    signature = nextSignature;
    // 読み直した拡張機能の失敗の記録は、消す（直したものを、もう一度試せる）。
    for (const ext of new Set(
      [...previous.editors, ...previous.previewers].map((e) => e.extensionId),
    ))
      placement.clearFailures(ext);
    for (const listener of [...listeners]) listener(previous, next);
  });

  return {
    placement,
    opener,
    surfaces: () => surfaces,
    nameOf: (id: string) => displayName(host.infos(), id),
    /** 画面の宣言が変わった（拡張機能の導入・削除・有効化・無効化）。 */
    onDidChangeSurfaces(
      listener: (previous: Surfaces, next: Surfaces) => void,
    ) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type PlacementRuntime = ReturnType<typeof createPlacementRuntime>;
