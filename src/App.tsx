import { getCurrentWindow } from "@tauri-apps/api/window";
import { onMount } from "solid-js";
import { detectLanguage, t } from "./i18n";
import { commands } from "./ipc";
import { startup } from "./shell/startup";

export function App() {
  onMount(() => {
    void startup({
      setTitle: (title) => getCurrentWindow().setTitle(title),
      appInfo: () => commands.appInfo(),
      reportReady: () => commands.reportReady(),
      t: (key) => t(key, detectLanguage()),
      // onMount は最初の描画の後に呼ばれる。さらに 1 フレーム待って画面に出たあとで知らせる。
      onFirstRender: (callback) => {
        requestAnimationFrame(() => callback());
      },
    });
  });
  return <main />;
}
