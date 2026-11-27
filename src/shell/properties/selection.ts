// アノテーションの選択（現在位置のものだけ）。純粋なストア。
export interface Selection {
  ids(): ReadonlySet<string>;
  /** `multi` のときは、選択に足す・外す。そうでなければ、それだけを選ぶ。 */
  select(id: string, multi: boolean): void;
  clear(): void;
  /** 一覧から消えた ID を、選択から外す。 */
  retain(existing: ReadonlySet<string>): void;
  subscribe(listener: () => void): () => void;
}

export function createSelection(): Selection {
  let ids = new Set<string>();
  const listeners = new Set<() => void>();
  const set = (next: Set<string>) => {
    ids = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    ids: () => ids,
    select(id, multi) {
      if (!multi) return set(new Set([id]));
      const next = new Set(ids);
      if (!next.delete(id)) next.add(id);
      set(next);
    },
    clear() {
      if (ids.size > 0) set(new Set());
    },
    retain(existing) {
      const next = new Set([...ids].filter((id) => existing.has(id)));
      if (next.size !== ids.size) set(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
