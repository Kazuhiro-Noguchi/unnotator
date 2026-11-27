// 現在位置（いま開いているアセットとアイテム）のストア。
// ツリーの選択・ナビゲーション・エディター領域が共有する（contracts/explorer-api.md の 2）。
import type { CurrentTarget } from "./types";

export interface CurrentStore {
  get(): CurrentTarget | null;
  /** ツリーの選択・ナビゲーションが呼ぶ。同じ位置なら知らせない。 */
  open(target: CurrentTarget): void;
  /** プロジェクトを閉じる・切り替えるとき。 */
  clear(): void;
  subscribe(listener: () => void): () => void;
}

function same(a: CurrentTarget | null, b: CurrentTarget | null): boolean {
  return a?.assetId === b?.assetId && a?.itemKey === b?.itemKey;
}

export function createCurrentStore(): CurrentStore {
  let current: CurrentTarget | null = null;
  const listeners = new Set<() => void>();
  const set = (next: CurrentTarget | null) => {
    if (same(current, next)) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => current,
    open: (target) =>
      set({
        assetId: target.assetId,
        itemKey: target.itemKey,
        mediaType: target.mediaType,
      }),
    clear: () => set(null),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
