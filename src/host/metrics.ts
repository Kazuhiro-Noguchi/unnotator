// 拡張機能ごとの計測（FR-023）。有効化の時間・呼び出しの回数と所要時間・失敗回数。
// 50 ms を超える呼び出しは、遅い呼び出しとして数え、警告として通知する（洪水にしないよう間引く）。

export const SLOW_CALL_MS = 50;
const WARN_INTERVAL_MS = 1000;

export interface ExtensionMetrics {
  /** 枠の生成から `activate` の完了まで。 */
  activationMs?: number;
  calls: number;
  totalCallMs: number;
  maxCallMs: number;
  failures: number;
  slowCalls: number;
}

export interface MetricsOptions {
  /** 遅い呼び出しの警告。 */
  onSlow?(extId: string, method: string, ms: number): void;
  now?(): number;
}

export interface Metrics {
  recordActivation(extId: string, ms: number): void;
  recordCall(extId: string, method: string, ms: number, ok: boolean): void;
  snapshot(): Record<string, ExtensionMetrics>;
  reset(extId: string): void;
  subscribe(listener: () => void): { dispose(): void };
}

export function createMetrics(options: MetricsOptions = {}): Metrics {
  const now = options.now ?? (() => Date.now());
  const table = new Map<string, ExtensionMetrics>();
  const lastWarned = new Map<string, number>();
  const listeners = new Set<() => void>();

  const entry = (id: string): ExtensionMetrics => {
    let m = table.get(id);
    if (m === undefined) {
      m = { calls: 0, totalCallMs: 0, maxCallMs: 0, failures: 0, slowCalls: 0 };
      table.set(id, m);
    }
    return m;
  };
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  return {
    recordActivation(extId, ms) {
      entry(extId).activationMs = ms;
      emit();
    },
    recordCall(extId, method, ms, ok) {
      const m = entry(extId);
      m.calls += 1;
      m.totalCallMs += ms;
      m.maxCallMs = Math.max(m.maxCallMs, ms);
      if (!ok) m.failures += 1;
      if (ms > SLOW_CALL_MS) {
        m.slowCalls += 1;
        const key = `${extId}\u0000${method}`;
        const t = now();
        const last = lastWarned.get(key);
        if (last === undefined || t - last >= WARN_INTERVAL_MS) {
          lastWarned.set(key, t);
          options.onSlow?.(extId, method, ms);
        }
      }
      emit();
    },
    snapshot() {
      return Object.fromEntries([...table].map(([id, m]) => [id, { ...m }]));
    },
    reset(extId) {
      table.delete(extId);
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
  };
}
