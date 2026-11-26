// アプリで使うエクスプローラーのセッション（1 つだけ）。実際の IPC・設定・イベントにつなぐ。
import { commands, events } from "../../ipc";
import { settingsPort } from "../ipc-port";
import { ctx } from "../services";
import { createExplorerSession } from "./session";

/** イベントの購読。Tauri の外（ブラウザでの確認）では失敗するので、黙って何もしない。 */
function listen(
  source: { listen(handler: () => void): Promise<() => void> },
  handler: () => void,
): () => void {
  const off = source.listen(handler).catch(() => () => {});
  return () => void off.then((fn) => fn());
}

export const explorer = createExplorerSession({
  ipc: {
    treeViewSet: (spec) => commands.treeViewSet(spec),
    treeRows: (version, offset, limit) =>
      commands.treeRows(version, offset, limit),
  },
  settings: settingsPort,
  ctx,
  onChanged(handler) {
    const offs = [
      listen(events.assetsChanged, handler),
      listen(events.projectChanged, handler),
    ];
    return () => {
      for (const off of offs) off();
    };
  },
});
