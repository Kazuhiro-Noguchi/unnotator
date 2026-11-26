// エクスプローラーの型（specs/007-tree-preview/data-model.md）。
// Rust の索引と通信する型は、IPC を足した時点で `src/ipc/` の生成物に置き換える。
import type { Status } from "../../ipc";

/** ツリーの 1 行（窓の 1 行）。 */
export type TreeRow =
  | {
      kind: "root";
      key: string;
      name: string;
      depth: number;
      expanded: boolean;
      total: number;
      done: number;
    }
  | {
      kind: "folder";
      key: string;
      name: string;
      depth: number;
      expanded: boolean;
      total: number;
      done: number;
    }
  | {
      kind: "asset";
      id: string;
      name: string;
      depth: number;
      media_type: string | null;
      status: Status;
      missing: boolean;
      expanded: boolean;
      pinned: boolean;
    }
  | { kind: "item_slot"; asset_id: string; index: number; depth: number }
  | { kind: "item_loading"; asset_id: string; depth: number };

export interface TreeWindow {
  version: number;
  total: number;
  offset: number;
  rows: TreeRow[];
}

/** 媒体種別の選択。`null` は「不明」。 */
export type MediaSel = { kind: "unknown" } | { kind: "is"; value: string };

export interface TreeFilter {
  name: string | null;
  statuses: Status[];
  media_types: MediaSel[];
  missing: boolean | null;
}

export interface Neighbor {
  asset_id: string | null;
  skipped_missing: number;
  reached_end: boolean;
}

export interface CurrentTarget {
  assetId: string;
  itemKey: string | null;
}
