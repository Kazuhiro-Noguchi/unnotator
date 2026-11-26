// アイテムのデモ（開発ビルドだけ）。拡張機能が無くても、ツリーのアイテム展開を確かめられるようにする。
// 拡張子 `.pages` のファイルを「デモの媒体」とみなし、1 つにつき 25 件のアイテムを、提供元の代わりに返す。
// 製品のビルドには含めない（App.tsx の `import.meta.env.DEV`）。
import type { HostItemSource } from "../../host/item-source";
import { commands } from "../../ipc";

export const DEMO_MEDIA_TYPE = "demo/paged";
const DEMO_ITEM_COUNT = 25;

export async function enableItemDemo(
  itemSource: HostItemSource,
): Promise<void> {
  itemSource.declare(DEMO_MEDIA_TYPE, {
    workUnit: "item",
    provider: "demo/pages",
    hasItems: true,
  });
  itemSource.connect(async (_assetId, range) => {
    const items = [];
    const end = Math.min(DEMO_ITEM_COUNT, range.offset + range.limit);
    for (let index = range.offset; index < end; index += 1) {
      items.push({ key: `page:${index + 1}`, title: `Page ${index + 1}` });
    }
    return { items, total: DEMO_ITEM_COUNT };
  });
  // 既存のアセットにも反映する（変更は通知され、ツリーが取り直す）。
  await commands.assetSetMediaRules({
    rules: [{ media_type: DEMO_MEDIA_TYPE, extensions: ["pages"] }],
  });
}
