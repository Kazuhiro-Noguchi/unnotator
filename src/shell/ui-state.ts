// 重ねて出す部品（パレット・設定・バージョン情報・Backstage・フォルダの入力）の開閉の状態。
import { createSignal } from "solid-js";

export const [paletteOpen, setPaletteOpen] = createSignal(false);
export const [settingsOpen, setSettingsOpen] = createSignal(false);
export const [aboutOpen, setAboutOpen] = createSignal(false);
export const [backstageOpen, setBackstageOpen] = createSignal(false);
export const [schemaOpen, setSchemaOpen] = createSignal(false);

export interface FolderRequest {
  title: string;
  resolve: (path: string | null) => void;
}
export const [folderRequest, setFolderRequest] =
  createSignal<FolderRequest | null>(null);

/** 既定の FolderPicker。パスを入力する簡易のダイアログを開いて、結果を待つ。 */
export const dialogFolderPicker = {
  pick(options: { title: string }): Promise<string | null> {
    return new Promise((resolve) => {
      setFolderRequest({
        title: options.title,
        resolve: (path) => {
          setFolderRequest(null);
          resolve(path);
        },
      });
    });
  },
};

/** ウィンドウを閉じるときの、未保存の確認。選ばれるまで待つ。 */
export const [closeRequest, setCloseRequest] = createSignal<{
  resolve: (decision: "save" | "discard" | "cancel") => void;
} | null>(null);

export function askCloseDecision(): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    setCloseRequest({
      resolve: (decision) => {
        setCloseRequest(null);
        resolve(decision);
      },
    });
  });
}

/** リボンで選んでいるタブ。 */
export const [ribbonSelected, setRibbonSelected] = createSignal("home");
