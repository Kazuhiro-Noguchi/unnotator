// シェルのテストが共通で使う道具。実際の IPC・DOM・タイマーの代わりになる。
import type { ProblemInput, ProblemSink } from "../types";

/** 問題の受け皿。集まった問題を取り出せる。 */
export function makeProblemSink(): {
  sink: ProblemSink;
  problems: ProblemInput[];
} {
  const problems: ProblemInput[] = [];
  return { sink: (p) => problems.push(p), problems };
}

/** 偽のイベントの発生源。購読と発火ができる。 */
export class FakeEmitter<T> {
  private handlers = new Set<(payload: T) => void>();
  listen(handler: (payload: T) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(payload: T): void {
    for (const handler of [...this.handlers]) handler(payload);
  }
  get size(): number {
    return this.handlers.size;
  }
}

/** 偽の設定ファイル（user 層）。`settingsLayer` / `settingsSet` と同じ形。 */
export class FakeUserSettings {
  values: Record<string, unknown> = {};
  setCalls: Array<{ key: string; valueJson: string }> = [];
  failSet = false;
  failLayer = false;

  constructor(initial: Record<string, unknown> = {}) {
    this.values = { ...initial };
  }

  async layer(): Promise<string> {
    if (this.failLayer) throw new Error("layer failed");
    return JSON.stringify(this.values);
  }

  async set(key: string, valueJson: string): Promise<void> {
    this.setCalls.push({ key, valueJson });
    if (this.failSet) throw new Error("set failed");
    this.values[key] = JSON.parse(valueJson);
  }
}

export interface FakeKeyInit {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target?: unknown;
  repeat?: boolean;
}

/** `KeyboardEvent` の代わり。`preventDefault` の呼び出しを記録する。 */
export function fakeKeyEvent(init: FakeKeyInit) {
  let prevented = false;
  let stopped = false;
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    isComposing: init.isComposing ?? false,
    keyCode: init.keyCode ?? 0,
    repeat: init.repeat ?? false,
    target: init.target ?? null,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
    get defaultPrevented() {
      return prevented;
    },
    get propagationStopped() {
      return stopped;
    },
  };
}

/** 偽の編集可能な要素（入力欄）。 */
export function fakeElement(tag: string, editable = false) {
  return { tagName: tag.toUpperCase(), isContentEditable: editable };
}

// ---------------------------------------------------------------------------
// アセットツリー（007）
// ---------------------------------------------------------------------------

import type { AssetRow, Status } from "../../ipc";
import type {
  MediaSel,
  Neighbor,
  TreeFilter,
  TreeRow,
  TreeWindow,
} from "../explorer/types";

/** `AssetRow` を作る小さな工場。指定しない項目は、見本の値になる。 */
export function makeAsset(
  id: string,
  relPath: string,
  patch: Partial<AssetRow> = {},
): AssetRow {
  return {
    id,
    root_key: "",
    rel_path: relPath,
    media_type: null,
    file_size: 1,
    mtime_ms: 1,
    status: "todo",
    missing: false,
    ...patch,
  };
}

/** 窓の取得で版が古いときの印。実際の `IpcError::StaleView` と同じ名前で投げる。 */
export class FakeStaleView extends Error {
  readonly kind = "StaleView";
  constructor() {
    super("StaleView");
  }
}

export interface FakeTreeViewArgs {
  filter: TreeFilter;
  expandedFolders: string[];
  expandedAssets: Array<{ asset_id: string; item_total: number }>;
  pinned: string | null;
}

/** ツリーの偽の IPC。行は `setRows` で与え、版の進みと `StaleView` を再現できる。 */
export class FakeTreeIpc {
  rows: TreeRow[] = [];
  version = 0;
  viewCalls: FakeTreeViewArgs[] = [];
  rowCalls: Array<{ version: number; offset: number; limit: number }> = [];
  neighborCalls: Array<{
    from: string | null;
    direction: "prev" | "next";
    unfinishedOnly: boolean;
    filter: TreeFilter;
  }> = [];
  neighbors: Neighbor[] = [];
  recorded = new Map<string, Array<{ key: string; status: Status }>>();
  traits: Array<{
    media_type: string;
    work_unit: "asset" | "item";
    provider: string | null;
  }> = [];
  opened: string[] = [];
  located = new Map<string, { row: number | null; ancestors: string[] }>();

  setRows(rows: TreeRow[]): void {
    this.rows = rows;
    this.version += 1;
  }

  /** 版を進める（アセットの増減の再現）。以後、古い版の取得は `StaleView`。 */
  invalidate(): void {
    this.version += 1;
  }

  async treeViewSet(args: FakeTreeViewArgs) {
    this.viewCalls.push(args);
    return {
      version: this.version,
      total: this.rows.length,
      generation: this.version,
    };
  }

  async treeRows(
    version: number,
    offset: number,
    limit: number,
  ): Promise<TreeWindow> {
    this.rowCalls.push({ version, offset, limit });
    if (version !== this.version) throw new FakeStaleView();
    return {
      version,
      total: this.rows.length,
      offset,
      rows: this.rows.slice(offset, offset + limit),
    };
  }

  async treeLocate(_version: number, assetId: string) {
    return this.located.get(assetId) ?? { row: null, ancestors: [] };
  }

  async treeNeighbor(
    from: string | null,
    direction: "prev" | "next",
    unfinishedOnly: boolean,
    filter: TreeFilter,
  ): Promise<Neighbor> {
    this.neighborCalls.push({ from, direction, unfinishedOnly, filter });
    return (
      this.neighbors.shift() ?? {
        asset_id: null,
        skipped_missing: 0,
        reached_end: true,
      }
    );
  }

  async itemStatuses(assetId: string) {
    return this.recorded.get(assetId) ?? [];
  }

  async mediaTraits() {
    return this.traits;
  }

  async openInDefaultApp(assetId: string): Promise<void> {
    this.opened.push(assetId);
  }
}

export type { MediaSel };
