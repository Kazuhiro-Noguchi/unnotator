// ナビゲーション: 作業単位（アセット / アイテム）に従う前後・次の未完了・完了して次へ。
// 出入口（`NavPorts`）を受け取る純関数。specs/007-tree-preview/research.md R6、contracts/explorer-api.md の 3。

import type { ItemInfo, ItemPage, MediaTraits } from "../../host/item-source";
import type { Direction, Status } from "../../ipc";
import type { CurrentStore } from "./current";
import type { CurrentTarget, Neighbor, TreeFilter } from "./types";

export type NavResult =
  | { kind: "moved"; target: CurrentTarget; skippedMissing: number }
  /** 端（先頭 / 末尾）で止まった。 */
  | { kind: "end"; direction: Direction }
  /** 未完了が無い。 */
  | { kind: "nothing-unfinished" }
  | { kind: "failed"; reason: "write" | "source" };

export interface NavPorts {
  /** Rust の索引でのアセットの探索。`itemMediaTypes` は、アイテムの状態で決まる媒体種別。 */
  neighbor(
    from: string | null,
    direction: Direction,
    unfinishedOnly: boolean,
    filter: TreeFilter,
    itemMediaTypes: string[],
  ): Promise<Neighbor>;
  traitsOf(mediaType: string | null): MediaTraits;
  /** アイテム提供元（`ItemSource.list`）。 */
  items: {
    list(
      assetId: string,
      range: { offset: number; limit: number },
      signal: AbortSignal,
    ): Promise<ItemPage>;
  };
  /** 記録のあるアイテムの状態。 */
  recordedStatuses(
    assetId: string,
  ): Promise<Array<{ key: string; status: Status }>>;
  /** 状態を変える（`apply_command`）。失敗したら例外。 */
  applyStatus(target: CurrentTarget, status: Status): Promise<void>;
  current: CurrentStore;
  filter(): TreeFilter;
  /** アイテム単位の媒体種別の一覧（Rust の探索に渡す）。 */
  itemMediaTypes?(): string[];
}

const PAGE = 200;
/** 完了済みのアセットを何件まで読み飛ばして探すか（無限に回らないための上限）。 */
const MAX_HOPS = 100_000;

async function allItems(
  ports: NavPorts,
  assetId: string,
): Promise<{ infos: ItemInfo[]; recorded: Map<string, Status> }> {
  const signal = new AbortController().signal;
  const infos: ItemInfo[] = [];
  let offset = 0;
  for (;;) {
    const page = await ports.items.list(
      assetId,
      { offset, limit: PAGE },
      signal,
    );
    infos.push(...page.items);
    offset += page.items.length;
    const total = page.total;
    if (page.items.length < PAGE || (total !== undefined && offset >= total)) {
      break;
    }
  }
  const recorded = new Map(
    (await ports.recordedStatuses(assetId)).map((r) => [r.key, r.status]),
  );
  return { infos, recorded };
}

/** 記録を優先し、無ければ提供元の状態、それも無ければ未着手。 */
function statusOf(info: ItemInfo, recorded: Map<string, Status>): Status {
  return recorded.get(info.key) ?? info.status ?? "todo";
}

/** アセットの中で、`fromKey` の次 / 前のアイテム。`fromKey` が無ければ先頭 / 末尾から。 */
async function findItem(
  ports: NavPorts,
  assetId: string,
  fromKey: string | null,
  direction: Direction,
  unfinished: boolean,
): Promise<string | null> {
  const { infos, recorded } = await allItems(ports, assetId);
  const ok = (info: ItemInfo) =>
    !unfinished || statusOf(info, recorded) !== "done";
  let start: number;
  if (fromKey === null) {
    start = direction === "next" ? -1 : infos.length;
  } else {
    start = infos.findIndex((i) => i.key === fromKey);
    if (start < 0) return null;
  }
  if (direction === "next") {
    return infos.slice(start + 1).find(ok)?.key ?? null;
  }
  return infos.slice(0, start).reverse().find(ok)?.key ?? null;
}

function itemMedia(ports: NavPorts): string[] {
  return ports.itemMediaTypes?.() ?? [];
}

async function neighborOf(
  ports: NavPorts,
  from: string | null,
  direction: Direction,
  unfinished: boolean,
): Promise<Neighbor> {
  return ports.neighbor(
    from,
    direction,
    unfinished,
    ports.filter(),
    itemMedia(ports),
  );
}

/** 前 / 次の作業単位（`unfinished` なら、完了でない次 / 前）へ移動する。 */
export async function navigate(
  ports: NavPorts,
  direction: Direction,
  unfinished: boolean,
): Promise<NavResult> {
  const end = (): NavResult =>
    unfinished ? { kind: "nothing-unfinished" } : { kind: "end", direction };
  try {
    const current = ports.current.get();
    let skipped = 0;
    let from = current?.assetId ?? null;

    // 1. 同じアセットの中の、次 / 前のアイテム。
    if (
      current &&
      ports.traitsOf(current.mediaType).workUnit === "item" &&
      current.itemKey !== null
    ) {
      const key = await findItem(
        ports,
        current.assetId,
        current.itemKey,
        direction,
        unfinished,
      );
      if (key !== null) {
        const target = { ...current, itemKey: key };
        ports.current.open(target);
        return { kind: "moved", target, skippedMissing: 0 };
      }
    }

    // 2. ほかのアセットへ。アイテム単位のアセットは、中の最初 / 最後の（未完了の）アイテムを開く。
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const found = await neighborOf(ports, from, direction, unfinished);
      skipped += found.skipped_missing;
      if (found.asset_id === null) return end();
      const traits = ports.traitsOf(found.media_type);
      if (traits.workUnit === "item") {
        const key = await findItem(
          ports,
          found.asset_id,
          null,
          direction,
          unfinished,
        );
        if (key === null) {
          from = found.asset_id;
          continue;
        }
        const target = {
          assetId: found.asset_id,
          itemKey: key,
          mediaType: found.media_type,
        };
        ports.current.open(target);
        return { kind: "moved", target, skippedMissing: skipped };
      }
      const target = {
        assetId: found.asset_id,
        itemKey: null,
        mediaType: found.media_type,
      };
      ports.current.open(target);
      return { kind: "moved", target, skippedMissing: skipped };
    }
    return end();
  } catch (error) {
    // 提供元の失敗・時間切れ・索引の読み出しの失敗。位置は動かさない。
    void error;
    return { kind: "failed", reason: "source" };
  }
}

/** 開いているものを完了にして、次の未完了へ進む。完了にできなければ、移動しない。 */
export async function markDoneAndNext(ports: NavPorts): Promise<NavResult> {
  const current = ports.current.get();
  if (!current) return { kind: "nothing-unfinished" };
  try {
    await ports.applyStatus(current, "done");
  } catch {
    return { kind: "failed", reason: "write" };
  }
  return navigate(ports, "next", true);
}
