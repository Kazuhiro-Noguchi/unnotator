// 候補（`annotations.suggest`）の仮の状態（FR-025〜027、research.md R10）。
// 検査済みの `NewAnnotation` をアセット（と対象）ごとにメモリだけで持つ。DB にも履歴にも未保存の印にも触れない。
// 採用は、提案した拡張機能の名前で、既存の `Transaction` コマンド 1 つとして送る（1 回の Undo）。
// 却下は一覧から消すだけ。このファイルはメディアの中身を知らない（選択範囲 `selector` は不透明な値）。
import type { HostIpc } from "./host-api/ipc";

export type SuggestionCommand = Parameters<HostIpc["applyCommand"]>[1];

/** 一覧と画面に出す候補。 */
export interface Suggestion {
  /** 候補の ID。採用すると、そのままアノテーションの ID になる。 */
  id: string;
  assetId: string;
  itemKey: string | null;
  /** `<拡張機能 ID>/<ローカル名>` */
  type: string;
  /** 種別の `summarize` の結果（無ければ空）。 */
  summary: string;
  selector: unknown;
  labelId: string | null;
  /** 提案した拡張機能の ID（ホストが付ける）。 */
  source: string;
  /** `suggest` の `opts.title`。 */
  title: string | null;
}

/** 検査を通った候補（`create_annotation` のコマンドまで作ってある）。 */
export interface SuggestionDraft extends Omit<Suggestion, "source" | "title"> {
  command: SuggestionCommand;
}

export interface SuggestionResultValue {
  accepted: string[];
  rejectedCount: number;
}

export interface SuggestionStore {
  /** 持つ。利用者がすべての候補を採用 / 却下する（またはプロジェクトを閉じる）まで、終わらない。 */
  add(batch: {
    source: string;
    title: string | null;
    items: SuggestionDraft[];
  }): Promise<SuggestionResultValue>;
  /** 対象の候補（追加順）。変化がなければ同じ配列を返す。 */
  list(assetId: string, itemKey: string | null): readonly Suggestion[];
  /** 全体の件数（プロジェクトを閉じる確認に使う）。 */
  count(): number;
  /** 採用する。採用できた候補の ID を返す。失敗したら投げ、候補は残す。 */
  accept(ids: readonly string[]): Promise<string[]>;
  acceptAll(assetId: string, itemKey: string | null): Promise<string[]>;
  reject(ids: readonly string[]): void;
  rejectAll(assetId: string, itemKey: string | null): void;
  /** すべて捨てる（プロジェクトを閉じるとき）。捨てた件数を返す。 */
  clearAll(): number;
  subscribe(listener: () => void): () => void;
}

export interface SuggestionStoreDeps {
  /** 拡張機能の名前で書く。`ext_apply_command` に結ぶ（Rust が権限を再確認する）。 */
  apply(source: string, command: SuggestionCommand): Promise<void>;
}

interface Batch {
  remaining: number;
  accepted: string[];
  rejected: number;
  resolve(result: SuggestionResultValue): void;
}

interface Entry {
  item: Suggestion;
  command: SuggestionCommand;
  batch: Batch;
}

const EMPTY: readonly Suggestion[] = Object.freeze([]);

function targetKey(assetId: string, itemKey: string | null): string {
  return itemKey === null
    ? `a\u0000${assetId}`
    : `i\u0000${assetId}\u0000${itemKey}`;
}

export function createSuggestionStore(
  deps: SuggestionStoreDeps,
): SuggestionStore {
  const byId = new Map<string, Entry>();
  const byTarget = new Map<string, readonly Suggestion[]>();
  const inflight = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  /** 持っている候補を外す。呼び出しごとの集計を進め、全部決まった呼び出しを終わらせる。 */
  function remove(entries: readonly Entry[], how: "accepted" | "rejected") {
    if (entries.length === 0) return;
    const gone = new Set(entries.map((e) => e.item.id));
    const touched = new Set<string>();
    for (const entry of entries) {
      byId.delete(entry.item.id);
      touched.add(targetKey(entry.item.assetId, entry.item.itemKey));
      if (how === "accepted") entry.batch.accepted.push(entry.item.id);
      else entry.batch.rejected += 1;
    }
    for (const key of touched) {
      const rest = (byTarget.get(key) ?? EMPTY).filter((s) => !gone.has(s.id));
      if (rest.length === 0) byTarget.delete(key);
      else byTarget.set(key, rest);
    }
    const finished = new Set<Batch>();
    for (const entry of entries) {
      entry.batch.remaining -= 1;
      if (entry.batch.remaining === 0) finished.add(entry.batch);
    }
    notify();
    for (const batch of finished)
      batch.resolve({
        accepted: batch.accepted,
        rejectedCount: batch.rejected,
      });
  }

  function entriesOf(ids: readonly string[]): Entry[] {
    const out: Entry[] = [];
    for (const id of new Set(ids)) {
      const entry = byId.get(id);
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }

  function idsOf(assetId: string, itemKey: string | null): string[] {
    return (byTarget.get(targetKey(assetId, itemKey)) ?? EMPTY).map(
      (s) => s.id,
    );
  }

  async function accept(ids: readonly string[]): Promise<string[]> {
    const entries = entriesOf(ids).filter((e) => !inflight.has(e.item.id));
    for (const entry of entries) inflight.add(entry.item.id);
    const accepted: string[] = [];
    try {
      // 拡張機能ごとに 1 つの Transaction。普通は 1 つ（= 1 回の Undo）。
      const groups = new Map<string, Entry[]>();
      for (const entry of entries) {
        const group = groups.get(entry.item.source) ?? [];
        group.push(entry);
        groups.set(entry.item.source, group);
      }
      for (const [source, group] of groups) {
        const [only] = group;
        const command: SuggestionCommand =
          group.length === 1 && only !== undefined
            ? only.command
            : ({
                kind: "transaction",
                commands: group.map((e) => e.command),
              } as SuggestionCommand);
        await deps.apply(source, command);
        remove(group, "accepted");
        accepted.push(...group.map((e) => e.item.id));
      }
    } finally {
      for (const entry of entries) inflight.delete(entry.item.id);
    }
    return accepted;
  }

  function reject(ids: readonly string[]): void {
    remove(
      entriesOf(ids).filter((e) => !inflight.has(e.item.id)),
      "rejected",
    );
  }

  return {
    add({ source, title, items }) {
      return new Promise<SuggestionResultValue>((resolve) => {
        if (items.length === 0)
          return resolve({ accepted: [], rejectedCount: 0 });
        const batch: Batch = {
          remaining: items.length,
          accepted: [],
          rejected: 0,
          resolve,
        };
        const added = new Map<string, Suggestion[]>();
        for (const draft of items) {
          const { command, ...rest } = draft;
          const item: Suggestion = { ...rest, source, title };
          byId.set(item.id, { item, command, batch });
          const key = targetKey(item.assetId, item.itemKey);
          const list = added.get(key) ?? [];
          list.push(item);
          added.set(key, list);
        }
        for (const [key, list] of added)
          byTarget.set(key, [...(byTarget.get(key) ?? EMPTY), ...list]);
        notify();
      });
    },
    list: (assetId, itemKey) =>
      byTarget.get(targetKey(assetId, itemKey)) ?? EMPTY,
    count: () => byId.size,
    accept,
    acceptAll: (assetId, itemKey) => accept(idsOf(assetId, itemKey)),
    reject,
    rejectAll: (assetId, itemKey) => reject(idsOf(assetId, itemKey)),
    clearAll() {
      const all = [...byId.values()];
      remove(all, "rejected");
      return all.length;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
