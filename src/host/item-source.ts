// アイテム提供元（拡張機能の `ItemProvider`）への問い合わせの境界。
// 実際の呼び出し（拡張機能ホスト）は 009 が結ぶ。007 は、この形と `FakeItemSource` までを作る。
// 形は specs/007-tree-preview/contracts/explorer-api.md の 1。
import type { Status } from "../ipc";

/** `plugin-api` の `ItemInfo` のうち、ツリーが使う部分。 */
export interface ItemInfo {
  /** 拡張機能が決める安定したキー（例 `page:3`）。 */
  key: string;
  title: string;
  description?: string;
  /** 提供元が知っている状態。DB の記録があれば、そちらを優先する。 */
  status?: Status;
  hasAnnotations?: boolean;
}

export type WorkUnit = "asset" | "item";

export interface MediaTraits {
  workUnit: WorkUnit;
  /** アイテム提供の宣言があるか（展開の矢印を出すか）。 */
  hasItems: boolean;
}

export type ItemSourceErrorKind = "timeout" | "failed" | "unsupported";

export class ItemSourceError extends Error {
  readonly kind: ItemSourceErrorKind;
  constructor(kind: ItemSourceErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "ItemSourceError";
    this.kind = kind;
  }
}

export interface ItemRange {
  offset: number;
  limit: number;
}

export interface ItemPage {
  items: ItemInfo[];
  /** 総数。提供元が知らなければ省く。 */
  total?: number;
}

export interface ItemSource {
  /** 媒体種別の作業単位とアイテム提供の有無。宣言が無ければ asset 単位・アイテム無し。 */
  traitsOf(mediaType: string | null): MediaTraits;
  list(
    assetId: string,
    range: ItemRange,
    signal: AbortSignal,
  ): Promise<ItemPage>;
}

const DEFAULT_TRAITS: MediaTraits = { workUnit: "asset", hasItems: false };

interface FakeAssetItems {
  count: number;
  statuses: Record<string, Status>;
  hideTotal: boolean;
  delayMs: number;
}

/** テストと開発用のデモが使う偽の提供元。 */
export class FakeItemSource implements ItemSource {
  readonly calls: Array<{ assetId: string; range: ItemRange }> = [];
  private readonly traits = new Map<string, MediaTraits>();
  private readonly assets = new Map<string, FakeAssetItems>();
  private readonly failures = new Map<string, ItemSourceErrorKind>();

  declare(mediaType: string, traits: MediaTraits): void {
    this.traits.set(mediaType, traits);
  }

  setItems(
    assetId: string,
    count: number,
    statuses: Record<string, Status> = {},
    options: { hideTotal?: boolean; delayMs?: number } = {},
  ): void {
    this.assets.set(assetId, {
      count,
      statuses,
      hideTotal: options.hideTotal ?? false,
      delayMs: options.delayMs ?? 0,
    });
  }

  failWith(assetId: string, kind: ItemSourceErrorKind | null): void {
    if (kind === null) this.failures.delete(assetId);
    else this.failures.set(assetId, kind);
  }

  traitsOf(mediaType: string | null): MediaTraits {
    return (mediaType !== null && this.traits.get(mediaType)) || DEFAULT_TRAITS;
  }

  async list(
    assetId: string,
    range: ItemRange,
    signal: AbortSignal,
  ): Promise<ItemPage> {
    this.calls.push({ assetId, range });
    const failure = this.failures.get(assetId);
    if (failure) throw new ItemSourceError(failure);
    const entry = this.assets.get(assetId);
    if (!entry) throw new ItemSourceError("unsupported");
    if (entry.delayMs > 0) await delay(entry.delayMs, signal);
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const end = Math.min(entry.count, range.offset + range.limit);
    const items: ItemInfo[] = [];
    for (let index = range.offset; index < end; index += 1) {
      const key = `item:${index}`;
      const status = entry.statuses[key];
      items.push({
        key,
        title: `Item ${index}`,
        ...(status ? { status } : {}),
      });
    }
    return entry.hideTotal ? { items } : { items, total: entry.count };
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
