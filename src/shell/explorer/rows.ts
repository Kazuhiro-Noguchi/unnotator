// ツリーの窓のキャッシュ。Rust の索引から、見える範囲の前後だけを取る（specs/007-tree-preview/research.md R4）。
// 版（version）が古い応答は捨てる。見え方の更新（refresh）のあいだは、古い行を見せ続ける。
import type { TreeRow, TreeWindow, ViewInfo, ViewSpec } from "./types";

/** 1 回の取得の行数。 */
export const PAGE_SIZE = 100;

export interface RowsPort {
  treeViewSet(spec: ViewSpec): Promise<ViewInfo>;
  treeRows(version: number, offset: number, limit: number): Promise<TreeWindow>;
}

export interface RowsStore {
  /** 見え方を設定し、キャッシュを捨てる（フィルターや開閉が変わったとき）。 */
  setView(spec: ViewSpec): Promise<void>;
  /** 同じ見え方を設定し直す。取り直すまで、古い行は見せ続ける（アセットの増減のとき）。 */
  refresh(): Promise<void>;
  total(): number;
  rowAt(index: number): TreeRow | undefined;
  /** 見える範囲 `[start, end)` と、その前後の 1 ページを取る。 */
  ensure(start: number, end: number): Promise<void>;
  subscribe(listener: () => void): () => void;
}

function isStale(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "stale_view"
  );
}

export function createRowsStore(port: RowsPort): RowsStore {
  let spec: ViewSpec | null = null;
  let version = -1;
  let total = 0;
  const pages = new Map<number, TreeRow[]>();
  /** 現在の版で取得済みのページ。 */
  let fetched = new Set<number>();
  let inflight = new Map<number, Promise<void>>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const lastPage = () => Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  /** 利用者の操作（setView / refresh）で進む。古い取得の結果を捨てる目印。 */
  let epoch = 0;
  /** 索引の作り直しによる見え方の設定し直し。同時に失敗した取得で、1 回にまとめる。 */
  let reviving: Promise<void> | null = null;

  async function applyView(next: ViewSpec, keepPages: boolean): Promise<void> {
    epoch += 1;
    await load(next, keepPages);
  }

  async function load(next: ViewSpec, keepPages: boolean): Promise<void> {
    const info = await port.treeViewSet(next);
    spec = next;
    version = info.version;
    total = info.total;
    fetched = new Set();
    inflight = new Map();
    if (!keepPages) pages.clear();
    else {
      // 総数が減ったときは、範囲外のページを捨てる。
      for (const page of [...pages.keys()]) {
        if (page > lastPage()) pages.delete(page);
      }
    }
    notify();
  }

  async function fetchPage(page: number, retried = false): Promise<void> {
    const mine = epoch;
    const forVersion = version;
    try {
      const window = await port.treeRows(
        forVersion,
        page * PAGE_SIZE,
        PAGE_SIZE,
      );
      if (epoch !== mine || version !== forVersion) return; // 見え方が変わった。古い応答は捨てる
      pages.set(page, window.rows);
      fetched.add(page);
      total = window.total;
      notify();
    } catch (error) {
      if (epoch !== mine) return;
      if (!isStale(error) || retried || spec === null) throw error;
      // 索引が作り直された。同じ見え方を設定し直して（同時の失敗は 1 回にまとめて）、取り直す。
      const current = spec;
      reviving ??= load(current, true).finally(() => {
        reviving = null;
      });
      await reviving;
      if (epoch !== mine) return;
      await fetchPage(page, true);
    }
  }

  return {
    setView: (next) => applyView(next, false),
    async refresh() {
      if (spec !== null) await applyView(spec, true);
    },
    total: () => total,
    rowAt(index) {
      if (index < 0 || index >= total) return undefined;
      return pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE];
    },
    async ensure(start, end) {
      if (total === 0) return;
      const first = Math.max(0, Math.floor(start / PAGE_SIZE) - 1);
      const last = Math.min(
        lastPage(),
        Math.floor(Math.max(start, end - 1) / PAGE_SIZE) + 1,
      );
      const jobs: Promise<void>[] = [];
      for (let page = first; page <= last; page += 1) {
        if (fetched.has(page)) continue;
        let job = inflight.get(page);
        if (!job) {
          const created = fetchPage(page).finally(() => {
            if (inflight.get(page) === created) inflight.delete(page);
          });
          inflight.set(page, created);
          job = created;
        }
        jobs.push(job);
      }
      await Promise.all(jobs);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
