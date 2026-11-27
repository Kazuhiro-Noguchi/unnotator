// 選択中のラベル = 現在位置（アセット・アイテム）に付いている分類のラベル。
// ラベルのカードのクリック（またはショートカットキー）は、分類を付け外しするので、選択はその結果として決まる。
// 別のアセットへ移ると、未分類なら何も選択されず、分類済みならそのラベルが選択される。
//
// 有効なラベル（`get()`）は、拡張機能の `labels.active()` / `labels.onDidChangeActive`（plugin-api）の元になる
// （結ぶのは 009）。複数選択のときは、先頭の 1 つ。非表示のラベルは、有効にならない。
import { createEffect, createMemo, on } from "solid-js";
import type { ProjectData } from "../project-data/store";
import type { LabelRow } from "../project-data/types";
import { fromStore } from "../solid";

export interface ActiveLabels {
  /** 選択中のラベルの ID（分類が付いているもの。非表示も含む）。 */
  ids(): ReadonlySet<string>;
  /** 有効なラベル（先頭の 1 つ。非表示・消えたものは除く）。 */
  get(): LabelRow | null;
  /** 有効なラベルが変わったとき（別のラベルになる・外れる・内容が変わる）に呼ぶ。 */
  subscribe(listener: () => void): () => void;
}

/** コンテキストのキー。コマンドやキーの `when` 式から使える（例: `activeLabelId != null`）。 */
export const ACTIVE_LABEL_CONTEXT_KEY = "activeLabelId";

/** 反応するスコープ（`createRoot`）の中で作る。 */
export function createActiveLabels(
  data: Pick<ProjectData, "labels" | "details" | "subscribe">,
  context: { set(key: string, value: string | null): void },
): ActiveLabels {
  const labels = fromStore(
    () => data.labels(),
    (listener) => data.subscribe(listener),
  );
  const details = fromStore(
    () => data.details(),
    (listener) => data.subscribe(listener),
  );
  const ids = createMemo<ReadonlySet<string>>(
    () =>
      new Set(
        (details()?.classification ?? []).flatMap((c) =>
          c.label_id === null ? [] : [c.label_id],
        ),
      ),
    new Set<string>(),
    {
      equals: (a, b) => a.size === b.size && [...a].every((id) => b.has(id)),
    },
  );
  const active = createMemo<LabelRow | null>(() => {
    const list = labels();
    for (const id of ids()) {
      const label = list.find((l) => l.id === id && !l.hidden);
      if (label !== undefined) return label;
    }
    return null;
  });
  const listeners = new Set<() => void>();
  createEffect(
    on(active, (label) => {
      context.set(ACTIVE_LABEL_CONTEXT_KEY, label?.id ?? null);
      for (const listener of [...listeners]) listener();
    }),
  );
  return {
    ids,
    get: active,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
