// 同期の API の写し（research.md R2）。ホストが押し込む。枠の中の呼び出しは、ここから同期で返す。

export type MirrorKey =
  | "selection"
  | "labels.active"
  | "settings"
  | "assets.current"
  | "tools.active";

export type MirrorInit = Record<MirrorKey, unknown>;

type Listener = (value: unknown) => void;

export interface Mirror {
  get(key: string): unknown;
  /** ホストからの差分。写しの値があれば置き換え、購読者に知らせる。 */
  apply(key: string, value: unknown): void;
  /** 写しの値を持たないイベント（`annotations.change` など）も購読できる。 */
  on(key: string, listener: Listener): { dispose(): void };
}

export function createMirror(initial: Partial<MirrorInit>): Mirror {
  const values = new Map<string, unknown>(Object.entries(initial));
  const listeners = new Map<string, Set<Listener>>();
  return {
    get: (key) => values.get(key),
    apply(key, value) {
      if (values.has(key)) values.set(key, value);
      for (const listener of [...(listeners.get(key) ?? [])]) {
        try {
          listener(value);
        } catch {
          // 購読者の例外は、ほかの購読者に影響させない。
        }
      }
    },
    on(key, listener) {
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return { dispose: () => void set.delete(listener) };
    },
  };
}
