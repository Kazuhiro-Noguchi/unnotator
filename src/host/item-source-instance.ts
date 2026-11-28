// アプリの `ItemSource`（`src/shell/explorer/instance.ts`）に、拡張機能の `ItemProvider` の呼び出しを結ぶ。
import { commands } from "../ipc";
import { itemSource } from "../shell/explorer/instance";
import { extensionHost } from "./instance";
import { createItemLister } from "./item-source-host";
import { toAsset } from "./placement";

itemSource.connect(
  createItemLister({
    async target(assetId) {
      const row = await commands.assetGet(assetId);
      if (row === null) return null;
      return {
        asset: toAsset(row),
        provider: itemSource.traitsOf(row.media_type ?? null).provider,
      };
    },
    async background(extensionId) {
      try {
        await extensionHost.manager.activate(extensionId);
      } catch {
        return undefined;
      }
      return extensionHost.frames.background(extensionId)?.channel;
    },
  }),
);
