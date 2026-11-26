// OS 標準のダイアログ（tauri-plugin-dialog）。Tauri との通信は、ここだけを通す。
import { open } from "@tauri-apps/plugin-dialog";

/** フォルダを 1 つ選ぶ。キャンセルは null。 */
export const openDirectoryDialog = (options: {
  directory: true;
  multiple: false;
  title: string;
  canCreateDirectories: boolean;
}): Promise<string | null> => open(options);
