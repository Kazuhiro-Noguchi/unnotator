// 画面（エディター・プレビュー・ビュー）の選択と配置の判断（FR-006・FR-007）。
// マニフェストの宣言を集め、アセットの媒体種別に合う画面を 1 つ選ぶ。枠を作るのは `placement-frame.ts`。
// 媒体の中身は見ない。媒体種別の ID（完全な名前）で突き合わせるだけ。
import type { ExtensionInfo } from "./service";

export type EditorPriority = "default" | "option";
export type ViewLocation = "primarySidebar" | "panel" | "secondarySidebar";

interface SurfaceBase {
  extensionId: string;
  localId: string;
  /** 完全な名前（`<拡張機能の ID>/<局所名>`）。 */
  id: string;
  /** 画面用モジュール（拡張機能のフォルダからの相対パス）。 */
  entry: string;
}

export interface EditorEntry extends SurfaceBase {
  title: string;
  mediaTypes: string[];
  priority: EditorPriority;
}

export interface PreviewerEntry extends SurfaceBase {
  mediaTypes: string[];
}

export interface ViewEntry extends SurfaceBase {
  title: string;
  location: ViewLocation;
  icon: string | null;
  when: string | null;
}

export interface Surfaces {
  editors: EditorEntry[];
  previewers: PreviewerEntry[];
  views: ViewEntry[];
}

export const EMPTY_SURFACES: Surfaces = {
  editors: [],
  previewers: [],
  views: [],
};

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

function qualify(extensionId: string, ref: string): string {
  return ref.includes("/") ? ref : `${extensionId}/${ref}`;
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function mediaTypesOf(extensionId: string, value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === "string")
        .map((v) => qualify(extensionId, v))
    : [];
}

function base(extensionId: string, d: Json): SurfaceBase | null {
  const localId = str(d.id);
  const entry = str(d.entry);
  if (localId === null || entry === null) return null;
  return {
    extensionId,
    localId,
    id: str(d.qualifiedId) ?? `${extensionId}/${localId}`,
    entry,
  };
}

/** 有効な拡張機能のマニフェストから、画面の宣言を集める。読めないものは黙って飛ばす。 */
export function collectSurfaces(infos: readonly ExtensionInfo[]): Surfaces {
  const surfaces: Surfaces = { editors: [], previewers: [], views: [] };
  for (const info of infos) {
    if (info.status !== "enabled" || info.manifest === null) continue;
    let contributes: Json;
    try {
      const manifest: unknown = JSON.parse(info.manifest);
      if (!isObject(manifest) || !isObject(manifest.contributes)) continue;
      contributes = manifest.contributes;
    } catch {
      continue;
    }
    for (const d of list(contributes.editors)) {
      const b = base(info.id, d);
      if (b === null) continue;
      surfaces.editors.push({
        ...b,
        title: str(d.title) ?? b.localId,
        mediaTypes: mediaTypesOf(info.id, d.mediaTypes),
        priority: d.priority === "option" ? "option" : "default",
      });
    }
    for (const d of list(contributes.previewers)) {
      const b = base(info.id, d);
      if (b === null) continue;
      surfaces.previewers.push({
        ...b,
        mediaTypes: mediaTypesOf(info.id, d.mediaTypes),
      });
    }
    for (const d of list(contributes.views)) {
      const b = base(info.id, d);
      const location = d.location;
      if (
        b === null ||
        (location !== "primarySidebar" &&
          location !== "panel" &&
          location !== "secondarySidebar")
      )
        continue;
      surfaces.views.push({
        ...b,
        title: str(d.title) ?? b.localId,
        location,
        icon: str(d.icon),
        when: str(d.when),
      });
    }
  }
  return surfaces;
}

/** 媒体種別ごとの既定のエディターの保存先（プロジェクト設定。結線は呼び出し側）。 */
export interface EditorPreferences {
  get(mediaType: string): string | undefined;
  set(mediaType: string, editorId: string): void;
}

export type Placement =
  | { kind: "editor"; editor: EditorEntry; alternatives: EditorEntry[] }
  | { kind: "previewer"; previewer: PreviewerEntry }
  | { kind: "generic" };

export interface PlacementDeps {
  surfaces(): Surfaces;
  preferences: EditorPreferences;
}

export interface ResolveOptions {
  /** 「別のエディターで開く」で選ばれたエディター（保存しない）。 */
  use?: string;
}

export interface PlacementService {
  resolve(mediaType: string | null, options?: ResolveOptions): Placement;
  /** この媒体種別を開けるエディター（失敗したものを除く。選ぶ順）。 */
  editorsFor(mediaType: string | null): EditorEntry[];
  setDefault(mediaType: string, editorId: string): void;
  /** 画面が失敗した。次に開くときは、この画面を外す。 */
  reportFailure(surfaceId: string): void;
  clearFailures(extensionId: string): void;
}

export function createPlacement(deps: PlacementDeps): PlacementService {
  const failed = new Set<string>();

  function editorsFor(mediaType: string | null): EditorEntry[] {
    if (mediaType === null) return [];
    const matching = deps
      .surfaces()
      .editors.filter(
        (e) => e.mediaTypes.includes(mediaType) && !failed.has(e.id),
      );
    // 並べ替えは安定（同じ優先度は、登録の順）。
    const rank = (e: EditorEntry) => (e.priority === "default" ? 0 : 1);
    return [...matching].sort((a, b) => rank(a) - rank(b));
  }

  return {
    editorsFor,
    resolve(mediaType, options = {}) {
      const editors = editorsFor(mediaType);
      if (mediaType !== null) {
        const wanted =
          options.use ?? deps.preferences.get(mediaType) ?? undefined;
        const chosen =
          editors.find((e) => e.id === wanted) ??
          // 保存済みの既定が無くなっていたら、優先度の順に戻る。
          editors[0];
        if (chosen !== undefined)
          return { kind: "editor", editor: chosen, alternatives: editors };
        const previewer = deps
          .surfaces()
          .previewers.find(
            (p) => p.mediaTypes.includes(mediaType) && !failed.has(p.id),
          );
        if (previewer !== undefined) return { kind: "previewer", previewer };
      }
      return { kind: "generic" };
    },
    setDefault(mediaType, editorId) {
      const known = deps
        .surfaces()
        .editors.some(
          (e) => e.id === editorId && e.mediaTypes.includes(mediaType),
        );
      if (!known) throw new Error(`${editorId} does not handle ${mediaType}`);
      deps.preferences.set(mediaType, editorId);
    },
    reportFailure(surfaceId) {
      failed.add(surfaceId);
    },
    clearFailures(extensionId) {
      for (const id of [...failed]) {
        if (id.startsWith(`${extensionId}/`)) failed.delete(id);
      }
    },
  };
}
