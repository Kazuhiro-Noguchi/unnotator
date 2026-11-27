// 選択中のラベル（複数）と、有効なラベル（active label）。
// 選ぶのは、サイドバーのカードのクリック、または 1〜9 のショートカットキー。分類（`core/classification`）とは別で、
// 選ぶだけでは、何も付かない（分類を付けるのは、別のコマンド）。
//
// 有効なラベルは、選択の最後（最後に選んだもの）の 1 つ。拡張機能の `labels.active()` / `labels.onDidChangeActive`
// （plugin-api）の元になる（結ぶのは 009）。非表示のラベルと、消えたラベルは、選択から外れる。
import { createEffect, createMemo, on } from "solid-js";
import type { ProjectData } from "../project-data/store";
import type { LabelRow } from "../project-data/types";
import { fromStore } from "../solid";
import { pruneSelection } from "./selection";
import type { LabelsUi } from "./ui";

export interface ActiveLabel {
  /** 選択中のラベル（選んだ順）。 */
  selected(): readonly LabelRow[];
  /** 有効なラベル（選択の最後の 1 つ）。 */
  get(): LabelRow | null;
  /** 有効なラベルが変わったとき（別のラベルになる・外れる・内容が変わる）に呼ぶ。 */
  subscribe(listener: () => void): () => void;
}

/** コンテキストのキー。コマンドやキーの `when` 式から使える（例: `activeLabelId != null`）。 */
export const ACTIVE_LABEL_CONTEXT_KEY = "activeLabelId";

/** 反応するスコープ（`createRoot`）の中で作る。 */
export function createActiveLabel(
  ui: Pick<LabelsUi, "selection" | "setSelection">,
  data: Pick<ProjectData, "labels" | "subscribe">,
  context: { set(key: string, value: string | null): void },
): ActiveLabel {
  const labels = fromStore(
    () => data.labels(),
    (listener) => data.subscribe(listener),
  );
  // 消えたラベル・非表示のラベルは、選択から外す。
  createEffect(() => {
    const allowed = new Set(
      labels()
        .filter((l) => !l.hidden)
        .map((l) => l.id),
    );
    const current = ui.selection();
    const pruned = pruneSelection(current, allowed);
    if (pruned !== current) ui.setSelection(pruned);
  });
  const selected = createMemo<readonly LabelRow[]>(() =>
    ui
      .selection()
      .ids.flatMap(
        (id) => labels().find((l) => l.id === id && !l.hidden) ?? [],
      ),
  );
  const active = createMemo<LabelRow | null>(() => selected().at(-1) ?? null);
  const listeners = new Set<() => void>();
  createEffect(
    on(active, (label) => {
      context.set(ACTIVE_LABEL_CONTEXT_KEY, label?.id ?? null);
      for (const listener of [...listeners]) listener();
    }),
  );
  return {
    selected,
    get: active,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
