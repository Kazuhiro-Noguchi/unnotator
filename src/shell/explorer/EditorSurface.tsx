import { format, t } from "../../i18n";
import { commands, events } from "../../ipc";
import { openExternal } from "../../preview/external";
import "../../host/item-source-instance";
import { EditorArea } from "../layout/EditorArea";
import { resolveSurface } from "../layout/surfaces-instance";
import { notify } from "../services";
import { explorer } from "./instance";

/** イベントの購読。Tauri の外（ブラウザでの確認）では失敗するので、黙って何もしない。 */
function listen(
  source: { listen(handler: () => void): Promise<() => void> },
  handler: () => void,
): () => void {
  const off = source.listen(handler).catch(() => () => {});
  return () => void off.then((fn) => fn());
}

/** リンク切れのアセットの、再接続の候補を通知に出し、選ばれたら付け替える。 */
async function relink(assetId: string): Promise<void> {
  const asset = await commands.assetGet(assetId);
  const name = asset?.rel_path.split("/").pop() ?? assetId;
  const candidates = await commands.assetRelinkCandidates(assetId);
  if (candidates.length === 0) {
    notify("warn", t("preview.relinkNone"));
    return;
  }
  notify("info", format(t("preview.relinkPick"), { name }), {
    actions: candidates.slice(0, 3).map((candidate, index) => ({
      label: format(t("preview.relinkTo"), { path: candidate.rel_path }),
      primary: index === 0,
      run: () => {
        void commands
          .assetRelink(assetId, candidate.root_key, candidate.rel_path)
          .catch(() => notify("error", t("preview.relinkNone")));
      },
    })),
  });
}

/** アプリのエディター領域。拡張機能のエディターがあれば枠で出し、無ければ汎用プレビューを出す。 */
export function EditorSurface() {
  return (
    <EditorArea
      current={explorer.current}
      getAsset={(id) => commands.assetGet(id)}
      onChanged={(handler) => {
        const offs = [
          listen(events.assetsChanged, handler),
          listen(events.projectChanged, handler),
        ];
        return () => {
          for (const off of offs) off();
        };
      }}
      onOpenExternal={(id) =>
        void openExternal(id).catch(() =>
          notify("error", t("preview.openFailed")),
        )
      }
      onRelink={(id) => void relink(id).catch(() => {})}
      resolveSurface={resolveSurface}
    />
  );
}
