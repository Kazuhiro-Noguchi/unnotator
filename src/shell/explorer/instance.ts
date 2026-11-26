// アプリで使うエクスプローラーのセッション（1 つだけ）。実際の IPC・設定・イベントにつなぐ。
import { createHostItemSource } from "../../host/item-source";
import { commands, events } from "../../ipc";
import type { CommandRegistry } from "../commands/registry";
import { settingsPort } from "../ipc-port";
import { ctx } from "../services";
import type { Disposable, NotifyLevel } from "../types";
import { provideExplorerHandlers } from "./commands";
import { createItemRows } from "./items";
import type { NavPorts } from "./nav";
import { createExplorerSession } from "./session";

/** イベントの購読。Tauri の外（ブラウザでの確認）では失敗するので、黙って何もしない。 */
function listen(
  source: { listen(handler: () => void): Promise<() => void> },
  handler: () => void,
): () => void {
  const off = source.listen(handler).catch(() => () => {});
  return () => void off.then((fn) => fn());
}

/** 媒体種別の宣言（作業単位・アイテム提供）と、アイテム提供元の呼び出し口（009 が結ぶ）。 */
export const itemSource = createHostItemSource(() => commands.mediaTraits());
void itemSource.refresh();
listen(events.extensionsChanged, () => void itemSource.refresh());

export const explorer = createExplorerSession({
  items: createItemRows({
    source: itemSource,
    recordedStatuses: (assetId) => commands.itemStatuses(assetId),
  }),
  traitsOf: (mediaType) => itemSource.traitsOf(mediaType),
  ipc: {
    treeViewSet: (spec) => commands.treeViewSet(spec),
    treeRows: (version, offset, limit) =>
      commands.treeRows(version, offset, limit),
    treeLocate: (version, assetId) => commands.treeLocate(version, assetId),
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

/** 状態を変える（`apply_command`）。アイテムは、提供元の名前が要る。 */
async function applyStatus(
  target: { assetId: string; itemKey: string | null; mediaType: string | null },
  status: "todo" | "in_progress" | "done" | "review",
): Promise<void> {
  if (target.itemKey === null) {
    await commands.applyCommand({
      kind: "set_asset_status",
      asset_id: target.assetId,
      status,
    });
    return;
  }
  const provider = itemSource.traitsOf(target.mediaType).provider;
  if (provider === null) throw new Error("アイテムの提供元が分からない");
  await commands.applyCommand({
    kind: "set_item_status",
    item: {
      asset_id: target.assetId,
      item_key: target.itemKey,
      provider,
    },
    status,
  });
}

export const navPorts: NavPorts = {
  neighbor: (from, direction, unfinishedOnly, filter, itemMediaTypes) =>
    commands.treeNeighbor(
      from,
      direction,
      unfinishedOnly,
      filter,
      itemMediaTypes,
    ),
  traitsOf: (mediaType) => itemSource.traitsOf(mediaType),
  items: itemSource,
  recordedStatuses: (assetId) => commands.itemStatuses(assetId),
  applyStatus,
  current: explorer.current,
  filter: () => explorer.controller.snapshot().filter,
  itemMediaTypes: () => itemSource.itemMediaTypes(),
};

/** `core.nav.*`・`core.status.*` の処理を結ぶ。 */
export function provideExplorerCommands(
  registry: CommandRegistry,
  notify: (level: NotifyLevel, text: string) => void,
): Disposable {
  return provideExplorerHandlers({
    commands: registry,
    ports: navPorts,
    notify,
  });
}
