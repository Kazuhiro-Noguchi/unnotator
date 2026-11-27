// 有効なラベル（active label）: 選択中のラベル。サイドバーのカードのクリック、または 1〜9 のショートカットキーで選ぶ。
// 分類（`core/classification`）とは別で、選ぶだけでは、何も付かない（分類を付けるのは、別のコマンド）。
// 拡張機能の `labels.active()` / `labels.onDidChangeActive`（plugin-api）の元になる（結ぶのは 009）。
// 非表示のラベルと、消えたラベルは、有効にならない。
import { createEffect, createMemo, on } from "solid-js";
import type { ProjectData } from "../project-data/store";
import type { LabelRow } from "../project-data/types";
import { fromStore } from "../solid";
import type { LabelsUi } from "./ui";

export interface ActiveLabel {
  get(): LabelRow | null;
  /** 有効なラベルが変わったとき（別のラベルになる・外れる・内容が変わる）に呼ぶ。 */
  subscribe(listener: () => void): () => void;
}

/** コンテキストのキー。コマンドやキーの `when` 式から使える（例: `activeLabelId != null`）。 */
export const ACTIVE_LABEL_CONTEXT_KEY = "activeLabelId";

/** 反応するスコープ（`createRoot`）の中で作る。 */
export function createActiveLabel(
  ui: Pick<LabelsUi, "selected">,
  data: Pick<ProjectData, "labels" | "subscribe">,
  context: { set(key: string, value: string | null): void },
): ActiveLabel {
  const labels = fromStore(
    () => data.labels(),
    (listener) => data.subscribe(listener),
  );
  const active = createMemo<LabelRow | null>(() => {
    const id = ui.selected();
    return id === null
      ? null
      : (labels().find((l) => l.id === id && !l.hidden) ?? null);
  });
  const listeners = new Set<() => void>();
  createEffect(
    on(active, (label) => {
      context.set(ACTIVE_LABEL_CONTEXT_KEY, label?.id ?? null);
      for (const listener of [...listeners]) listener();
    }),
  );
  return {
    get: active,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
