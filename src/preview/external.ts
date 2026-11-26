// 「既定のアプリで開く」。プレビューが呼べる IPC は、これだけ（scripts/check-deps.mjs が検査する）。
import { commands } from "../ipc";

export async function openExternal(assetId: string): Promise<void> {
  await commands.openInDefaultApp(assetId);
}
