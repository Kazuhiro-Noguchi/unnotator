// 拡張機能の画面（エディター・プレビュー・ビュー）を、シェルの領域へ差し込む（FR-006〜FR-008）。
// 選択の判断は `src/host/placement.ts`、枠の生成は `src/host/placement-frame.ts`、入れ物は `SurfaceFrame`。
import { type Accessor, For, type JSX, Show } from "solid-js";
import {
  type EditorEntry,
  type PlacementService,
  toAsset,
  type ViewEntry,
} from "../../host/placement";
import type { SurfaceOpener, SurfaceRole } from "../../host/placement-frame";
import { t } from "../../i18n";
import type { AssetRow } from "../../ipc";
import type { Disposable } from "../types";
import { SurfaceFrame } from "./SurfaceFrame";
import type { ViewRegistry } from "./views";

export { toAsset };

export interface ResolveSurfaceDeps {
  placement: PlacementService;
  opener: SurfaceOpener;
  nameOf(extensionId: string): string;
  /** 宣言の変化・失敗・既定の変更で進む。読むと、選び直しが走る。 */
  version: Accessor<number>;
  bump(): void;
}

/** `EditorArea` の `resolveSurface`。エディターが無い・リンク切れなら `null`（汎用プレビューに落ちる）。 */
export function createResolveSurface(deps: ResolveSurfaceDeps) {
  return function resolveSurface(
    asset: AssetRow,
    itemKey: string | null,
  ): JSX.Element | null {
    deps.version();
    if (asset.missing) return null;
    const mediaType = asset.media_type ?? null;
    const placed = deps.placement.resolve(mediaType);
    if (placed.kind === "generic") return null;

    const chosen =
      placed.kind === "editor"
        ? { surface: placed.editor, role: "editor" as SurfaceRole }
        : { surface: placed.previewer, role: "preview" as SurfaceRole };
    const alternatives: EditorEntry[] =
      placed.kind === "editor" ? placed.alternatives : [];
    const ctx: Record<string, unknown> = { asset: toAsset(asset) };
    if (itemKey !== null) ctx.itemKey = itemKey;

    return (
      <div class="surface-area">
        <SurfaceFrame
          opener={deps.opener}
          request={{
            extensionId: chosen.surface.extensionId,
            surfaceId: chosen.surface.id,
            role: chosen.role,
            entry: chosen.surface.entry,
            ctx,
          }}
          name={deps.nameOf(chosen.surface.extensionId)}
          onFailed={() => {
            deps.placement.reportFailure(chosen.surface.id);
            deps.bump();
          }}
        />
        <Show when={mediaType !== null && alternatives.length > 1}>
          <select
            class="surface-switcher"
            aria-label={t("host.editor.switcher")}
            title={t("host.editor.openWith")}
            value={chosen.surface.id}
            onChange={(event) => {
              if (mediaType === null) return;
              deps.placement.setDefault(mediaType, event.currentTarget.value);
              deps.bump();
            }}
          >
            <For each={alternatives}>
              {(editor) => (
                <option
                  value={editor.id}
                  selected={editor.id === chosen.surface.id}
                >
                  {editor.title}
                </option>
              )}
            </For>
          </select>
        </Show>
      </div>
    );
  };
}

export interface ExtensionViewDeps {
  opener: SurfaceOpener;
  nameOf(extensionId: string): string;
}

const registered = new WeakMap<ViewRegistry, Map<string, Disposable[]>>();

/**
 * 拡張機能のビューを、宣言された場所に登録する。呼ぶたびに登録し直す
 * （無効・削除になった拡張機能のビューは、ここで取り除かれる）。
 */
export function syncExtensionViews(
  registry: ViewRegistry,
  entries: readonly ViewEntry[],
  deps: ExtensionViewDeps,
): void {
  const previous = registered.get(registry) ?? new Map<string, Disposable[]>();
  for (const sources of previous.values()) {
    for (const d of sources) d.dispose();
  }
  const next = new Map<string, Disposable[]>();
  for (const entry of entries) {
    const source = `ext-surface:${entry.extensionId}`;
    const disposable = registry.register({
      id: entry.id,
      title: entry.title,
      ...(entry.icon === null ? {} : { icon: entry.icon }),
      location: entry.location,
      ...(entry.when === null ? {} : { when: entry.when }),
      source,
      render: () => (
        <SurfaceFrame
          opener={deps.opener}
          request={{
            extensionId: entry.extensionId,
            surfaceId: entry.id,
            role: "view",
            entry: entry.entry,
            ctx: {},
          }}
          name={deps.nameOf(entry.extensionId)}
        />
      ),
    });
    next.set(entry.id, [...(next.get(entry.id) ?? []), disposable]);
  }
  registered.set(registry, next);
}
