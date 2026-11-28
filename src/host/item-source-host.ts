// 拡張機能の `ItemProvider` を、裏の枠へ `invoke` で呼ぶ `ItemLister`（`HostItemSource.connect` に渡す）。
// アセットの取得と枠の用意（有効化）は呼び出し側から受ける（DI）。
import { ChannelError } from "./channel";
import {
  type ItemInfo,
  type ItemLister,
  type ItemPage,
  ItemSourceError,
} from "./item-source";

export interface ItemTarget {
  /** 拡張機能へ渡すアセット（`plugin-api` の `Asset`）。 */
  asset: unknown;
  /** アイテム提供元の完全な名前（`<拡張機能の ID>/<局所名>`）。無ければ `null`。 */
  provider: string | null;
}

export interface ItemListerDeps {
  target(assetId: string): Promise<ItemTarget | null>;
  /** 拡張機能を有効にして、裏の枠を返す。枠が作れなければ `undefined`。 */
  background(
    extensionId: string,
  ): Promise<{ call(m: string, a: unknown): Promise<unknown> } | undefined>;
}

function isItemInfo(value: unknown): value is ItemInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.key === "string" && typeof v.title === "string";
}

function toPage(value: unknown): ItemPage {
  if (typeof value !== "object" || value === null)
    throw new ItemSourceError("failed", "invalid response");
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.items) || !v.items.every(isItemInfo))
    throw new ItemSourceError("failed", "invalid items");
  const items = v.items as ItemInfo[];
  return typeof v.total === "number" ? { items, total: v.total } : { items };
}

let tokenCounter = 0;

export function createItemLister(deps: ItemListerDeps): ItemLister {
  return async (assetId, range, signal) => {
    const target = await deps.target(assetId);
    if (target === null || target.provider === null)
      throw new ItemSourceError("unsupported");
    const slash = target.provider.indexOf("/");
    if (slash <= 0) throw new ItemSourceError("unsupported");
    const extensionId = target.provider.slice(0, slash);
    const localId = target.provider.slice(slash + 1);

    const frame = await deps.background(extensionId);
    if (frame === undefined) throw new ItemSourceError("failed", "no frame");
    if (signal.aborted) throw new DOMException("aborted", "AbortError");

    tokenCounter += 1;
    const token = `items-${tokenCounter}`;
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          void frame.call("abort", { token }).catch(() => {});
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
    const invoked = frame
      .call("invoke", {
        kind: "items",
        localId,
        member: "list",
        args: [target.asset, range],
        withSignal: token,
      })
      .catch((error: unknown) => {
        if (error instanceof ChannelError && error.code === "Timeout")
          throw new ItemSourceError("timeout");
        throw new ItemSourceError(
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      });
    return toPage(await Promise.race([invoked, aborted]));
  };
}
