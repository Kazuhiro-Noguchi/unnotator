// エディター領域。現在位置のアセットを、エディターがあればエディターで、無ければ汎用プレビューで出す。
// エディターの配置（拡張機能）は 009。ここでは差し込み口（`resolveSurface`）までを作る。
// specs/007-tree-preview/contracts/explorer-api.md の 4・research.md R8。
import {
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import type { AssetRow } from "../../ipc";
import { Preview } from "../../preview/Preview";
import type { CurrentStore } from "../explorer/current";
import { fromStore, useT } from "../solid";
import { EmptyState } from "./EmptyState";

export interface EditorAreaProps {
  current: CurrentStore;
  /** アセットの最新の行（リンク切れの印を含む）。知らなければ `null`。 */
  getAsset(id: string): Promise<AssetRow | null>;
  /** アセットの増減・状態の変化の通知。解除する関数を返す。 */
  onChanged(handler: () => void): () => void;
  onOpenExternal(assetId: string): void;
  onRelink(assetId: string): void;
  /** エディター（拡張機能）の表示を返す。無ければ `null`（汎用プレビューに落ちる）。009 が結ぶ。 */
  resolveSurface?(asset: AssetRow, itemKey: string | null): JSX.Element | null;
}

export function EditorArea(props: EditorAreaProps) {
  const t = useT();
  const target = fromStore(() => props.current.get(), props.current.subscribe);
  const [asset, setAsset] = createSignal<AssetRow | null>(null);
  // 表示を作り直す単位。アセットの ID・媒体種別・リンク切れが変わったときだけ変わる
  // （同じアセットの再取得では、エディターを作り直さない）。
  const surfaceKey = createMemo(() => {
    const a = asset();
    return a === null
      ? null
      : `${a.id}\u0000${a.media_type ?? ""}\u0000${a.missing}`;
  });
  // 取得のたびに進める。古い取得の結果で、新しい表示を上書きしない。
  let ticket = 0;

  async function load(assetId: string | null): Promise<void> {
    ticket += 1;
    const mine = ticket;
    if (assetId === null) {
      setAsset(null);
      return;
    }
    try {
      const row = await props.getAsset(assetId);
      if (mine === ticket) setAsset(row);
    } catch {
      if (mine === ticket) setAsset(null);
    }
  }

  createEffect(
    on(
      () => target()?.assetId ?? null,
      (assetId) => {
        void load(assetId);
      },
    ),
  );
  const off = props.onChanged(() => void load(target()?.assetId ?? null));
  onCleanup(off);

  return (
    <main
      class="editor-area"
      data-region="editor"
      aria-label={t("region.editor")}
    >
      <Show
        when={surfaceKey()}
        keyed
        fallback={<EmptyState message={t("empty.editor")} />}
      >
        {(_key) => {
          const row = untrack(asset);
          if (row === null) return null;
          // 差し込み口は、読む信号（拡張機能の読み込み・画面の宣言の変化）が変わったときも選び直す。
          const surface = createMemo(
            () =>
              props.resolveSurface?.(
                row,
                untrack(() => target()?.itemKey ?? null),
              ) ?? null,
          );
          return (
            <>
              {surface() ?? (
                <Preview
                  asset={asset() ?? row}
                  onOpenExternal={() => props.onOpenExternal(row.id)}
                  onRelink={() => props.onRelink(row.id)}
                />
              )}
            </>
          );
        }}
      </Show>
    </main>
  );
}
