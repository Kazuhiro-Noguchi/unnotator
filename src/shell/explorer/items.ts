// アイテムの行の中身（キー・名前・状態）。提供元（JS）から、100 件のページ単位で取る。
// 失敗は、そのアセットの中だけに閉じる。specs/007-tree-preview/research.md R5・data-model.md の `ItemRows`。
import {
  type ItemInfo,
  type ItemSource,
  ItemSourceError,
  type ItemSourceErrorKind,
} from "../../host/item-source";
import type { Status } from "../../ipc";

/** 1 回の取得の件数。 */
export const ITEM_PAGE_SIZE = 100;
/** 総数が分からない提供元の、数え上げの上限（ページ数）。 */
const MAX_COUNT_PAGES = 1000;

export type ItemCell =
  | { kind: "item"; info: ItemInfo; status: Status }
  | { kind: "loading" }
  | { kind: "error"; error: ItemSourceErrorKind };

export type AssetItemsState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; error: ItemSourceErrorKind }
  | { kind: "unsupported" };

export interface ItemRowsPorts {
  source: Pick<ItemSource, "list">;
  recordedStatuses(
    assetId: string,
  ): Promise<Array<{ key: string; status: Status }>>;
}

export interface ItemRows {
  /** 展開する。最初のページを取り、総数を返す（取れなければ `null`）。 */
  open(assetId: string): Promise<number | null>;
  close(assetId: string): void;
  /** 取り直す（エラーの再試行）。 */
  retry(assetId: string): Promise<number | null>;
  total(assetId: string): number | null;
  state(assetId: string): AssetItemsState;
  cell(assetId: string, index: number): ItemCell;
  /** `[start, end)` のアイテムを含むページを取る。 */
  ensure(assetId: string, start: number, end: number): Promise<void>;
  /** 記録された状態を読み直す（状態の変更のあと）。 */
  refreshStatuses(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

interface Entry {
  /** 開き直し・閉じるたびに変わる。古い取得の結果を捨てる目印。 */
  epoch: number;
  state: AssetItemsState;
  total: number | null;
  pages: Map<number, ItemInfo[]>;
  pageErrors: Map<number, ItemSourceErrorKind>;
  inflight: Map<number, Promise<void>>;
  recorded: Map<string, Status>;
}

function kindOf(error: unknown): ItemSourceErrorKind {
  return error instanceof ItemSourceError ? error.kind : "failed";
}

export function createItemRows(ports: ItemRowsPorts): ItemRows {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let epochCounter = 0;
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const signal = () => new AbortController().signal;

  async function fetchPage(
    assetId: string,
    entry: Entry,
    page: number,
  ): Promise<ItemInfo[] | null> {
    try {
      const result = await ports.source.list(
        assetId,
        { offset: page * ITEM_PAGE_SIZE, limit: ITEM_PAGE_SIZE },
        signal(),
      );
      if (entries.get(assetId) !== entry) return null;
      entry.pages.set(page, result.items);
      entry.pageErrors.delete(page);
      if (result.total !== undefined) entry.total = result.total;
      return result.items;
    } catch (error) {
      if (entries.get(assetId) !== entry) return null;
      const kind = kindOf(error);
      entry.pageErrors.set(page, kind);
      throw error;
    }
  }

  async function load(assetId: string, entry: Entry): Promise<number | null> {
    entry.state = { kind: "loading" };
    entry.pages.clear();
    entry.pageErrors.clear();
    entry.total = null;
    notify();
    try {
      const first = await fetchPage(assetId, entry, 0);
      if (first === null) return null;
      // 総数が分からない提供元は、短いページが来るまで数える。
      let page = 0;
      let last = first;
      while (
        entry.total === null &&
        last.length === ITEM_PAGE_SIZE &&
        page < MAX_COUNT_PAGES
      ) {
        page += 1;
        const next = await fetchPage(assetId, entry, page);
        if (next === null) return null;
        last = next;
      }
      if (entry.total === null) {
        entry.total = page * ITEM_PAGE_SIZE + last.length;
      }
      try {
        entry.recorded = new Map(
          (await ports.recordedStatuses(assetId)).map((r) => [r.key, r.status]),
        );
      } catch {
        // 記録が読めなくても、提供元の状態で表示する。
      }
      if (entries.get(assetId) !== entry) return null;
      entry.state = { kind: "ready" };
      notify();
      return entry.total;
    } catch (error) {
      if (entries.get(assetId) !== entry) return null;
      const kind = kindOf(error);
      entry.state =
        kind === "unsupported"
          ? { kind: "unsupported" }
          : { kind: "error", error: kind };
      notify();
      return null;
    }
  }

  function entryFor(assetId: string): Entry {
    const existing = entries.get(assetId);
    if (existing) return existing;
    epochCounter += 1;
    const created: Entry = {
      epoch: epochCounter,
      state: { kind: "loading" },
      total: null,
      pages: new Map(),
      pageErrors: new Map(),
      inflight: new Map(),
      recorded: new Map(),
    };
    entries.set(assetId, created);
    return created;
  }

  return {
    open(assetId) {
      const entry = entryFor(assetId);
      return load(assetId, entry);
    },
    close(assetId) {
      entries.delete(assetId);
      notify();
    },
    retry(assetId) {
      const entry = entryFor(assetId);
      return load(assetId, entry);
    },
    total: (assetId) => entries.get(assetId)?.total ?? null,
    state: (assetId) => entries.get(assetId)?.state ?? { kind: "loading" },
    cell(assetId, index) {
      const entry = entries.get(assetId);
      if (!entry) return { kind: "loading" };
      const page = Math.floor(index / ITEM_PAGE_SIZE);
      const error = entry.pageErrors.get(page);
      if (error) return { kind: "error", error };
      const info = entry.pages.get(page)?.[index % ITEM_PAGE_SIZE];
      if (!info) return { kind: "loading" };
      return {
        kind: "item",
        info,
        status: entry.recorded.get(info.key) ?? info.status ?? "todo",
      };
    },
    async ensure(assetId, start, end) {
      const entry = entries.get(assetId);
      if (!entry || entry.state.kind !== "ready") return;
      const first = Math.floor(start / ITEM_PAGE_SIZE);
      const last = Math.floor(Math.max(start, end - 1) / ITEM_PAGE_SIZE);
      const jobs: Promise<void>[] = [];
      for (let page = first; page <= last; page += 1) {
        if (entry.pages.has(page) || entry.pageErrors.has(page)) continue;
        let job = entry.inflight.get(page);
        if (!job) {
          const created = fetchPage(assetId, entry, page)
            .then(() => notify())
            .catch(() => notify())
            .finally(() => {
              entry.inflight.delete(page);
            });
          entry.inflight.set(page, created);
          job = created;
        }
        jobs.push(job);
      }
      await Promise.all(jobs);
    },
    async refreshStatuses() {
      for (const [assetId, entry] of entries) {
        try {
          entry.recorded = new Map(
            (await ports.recordedStatuses(assetId)).map((r) => [
              r.key,
              r.status,
            ]),
          );
        } catch {
          // 読めなければ、いまの表示のまま。
        }
      }
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
