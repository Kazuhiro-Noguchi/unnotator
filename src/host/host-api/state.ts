// 本体の状態の写しの元（research.md R2）。選択・有効なラベル・開いている対象・ツール・設定。
// ホストの持ち主（シェルの各部）が `set` し、枠へは差分として押し込まれる。

export type MirrorKey =
  | "selection"
  | "labels.active"
  | "settings"
  | "assets.current"
  | "tools.active";

export const MIRROR_KEYS: readonly MirrorKey[] = [
  "selection",
  "labels.active",
  "settings",
  "assets.current",
  "tools.active",
];

export interface HostState {
  get(key: MirrorKey): unknown;
  set(key: MirrorKey, value: unknown): void;
  subscribe(key: MirrorKey, listener: (value: unknown) => void): () => void;
}

const DEFAULTS: Record<MirrorKey, unknown> = {
  selection: [],
  "labels.active": null,
  settings: {},
  "assets.current": null,
  "tools.active": null,
};

export function createHostState(
  initial: Partial<Record<MirrorKey, unknown>> = {},
): HostState {
  const values = new Map<MirrorKey, unknown>(
    MIRROR_KEYS.map((k) => [k, initial[k] ?? DEFAULTS[k]]),
  );
  const listeners = new Map<MirrorKey, Set<(value: unknown) => void>>();
  return {
    get: (key) => values.get(key),
    set(key, value) {
      values.set(key, value);
      for (const listener of [...(listeners.get(key) ?? [])]) listener(value);
    },
    subscribe(key, listener) {
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => void set.delete(listener);
    },
  };
}
