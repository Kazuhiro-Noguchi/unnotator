// エクスプローラーの型（specs/007-tree-preview/data-model.md）。
// Rust の索引と通信する型は、IPC を足した時点で `src/ipc/` の生成物に置き換える。
import type { Status } from "../../ipc";

export type {
  Direction,
  ExpandedAsset,
  ItemStatusDto,
  Located,
  MediaSel,
  MediaTraitsDto,
  NodeKey,
  TreeRow,
  TreeWindow,
  ViewInfo,
  ViewSpec,
} from "../../ipc";

import type { MediaSel } from "../../ipc";

/** フィルター条件（`ViewSpec.filter` と同じ形。省略のない形で持つ）。 */
export interface TreeFilter {
  name: string | null;
  statuses: Status[];
  media_types: MediaSel[];
  missing: boolean | null;
}

export interface CurrentTarget {
  assetId: string;
  itemKey: string | null;
  /** アセットの媒体種別（作業単位を決めるため）。判定できなければ `null`。 */
  mediaType: string | null;
}

/** 探索の結果（受け取る側は、省略のない形で扱う）。 */
export type { Neighbor_Serialize as Neighbor } from "../../ipc";
