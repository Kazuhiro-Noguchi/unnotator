// アプリで使うプロジェクトのデータのキャッシュ（1 つだけ）。実際の IPC とイベントにつなぐ。
// `ipc` を使えるのは、このフォルダーだけ（scripts/check-deps.mjs）。
import { commands, events } from "../../ipc";
import { explorer } from "../explorer/instance";
import { createProjectData } from "./store";

export const projectData = createProjectData({
  ipc: {
    labelsList: () => commands.labelsList(),
    schemasList: () => commands.schemasList(),
    targetDetails: (assetId, itemKey) =>
      commands.targetDetails(assetId, itemKey),
    annotationsPage: (assetId, itemKey, cursor) =>
      commands.annotationsPage(assetId, itemKey, cursor),
    apply: (command) => commands.applyCommand(command),
  },
  current: explorer.current,
  onChanged(handler) {
    // Tauri の外（ブラウザでの確認）では購読に失敗するので、黙って何もしない。
    const off = events.projectChanged
      .listen((event) => handler(event.payload))
      .catch(() => () => {});
    return () => void off.then((fn) => fn());
  },
});

/** 設定 `core.classification.multiple`（分類ラベルを複数付けられるか）。読めなければ単一。 */
export async function readClassificationMultiple(): Promise<boolean> {
  try {
    const setting = await commands.settingsGet("core.classification.multiple");
    return JSON.parse(setting.value_json) === true;
  } catch {
    return false;
  }
}
