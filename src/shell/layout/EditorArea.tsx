// エディター領域。現在位置のアセットを、エディターがあればエディターで、無ければ汎用プレビューで出す。
// エディターの配置（拡張機能）は 009。ここでは差し込み口（`resolveSurface`）までを作る。
// specs/007-tree-preview/contracts/explorer-api.md の 4・research.md R8。
import {
  createEffect,
  createSignal,
  type JSX,
  on,
  onCleanup,
  Show,
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
        when={asset()}
        fallback={<EmptyState message={t("empty.editor")} />}
      >
        {(row) =>
          props.resolveSurface?.(row(), target()?.itemKey ?? null) ?? (
            <Preview
              asset={row()}
              onOpenExternal={() => props.onOpenExternal(row().id)}
              onRelink={() => props.onRelink(row().id)}
            />
          )
        }
      </Show>
    </main>
  );
}
