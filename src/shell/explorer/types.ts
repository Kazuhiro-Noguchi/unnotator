// エクスプローラーの型（specs/007-tree-preview/data-model.md）。
// Rust の索引と通信する型は、IPC を足した時点で `src/ipc/` の生成物に置き換える。
import type { Status } from "../../ipc";

export type {
  ExpandedAsset,
  Located,
  NodeKey,
  TreeRow,
  TreeWindow,
  ViewInfo,
  ViewSpec,
} from "../../ipc";

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
