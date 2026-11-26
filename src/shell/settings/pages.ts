// 設定画面のページ登録。カテゴリの下にページを並べる目次（ツリー）になる。
// 後続の機能（プロジェクト設定・拡張機能の管理・開発者モードなど）が、ページを足していく。
import type { JSX } from "solid-js";
import type { Title } from "../types";

export interface SettingsCategory {
  id: string;
  title: Title;
  order?: number;
  source: string;
}

export interface SettingsPageDef {
  id: string;
  category: string;
  title: Title;
  order?: number;
  render: () => JSX.Element;
  source: string;
}

export interface SettingsTreeNode extends SettingsCategory {
  pages: SettingsPageDef[];
}

/** 指すカテゴリが無いページの置き場。 */
const OTHER: SettingsCategory = {
  id: "other",
  title: { ja: "その他", en: "Other" },
  order: 1000,
  source: "core",
};

export function createSettingsPages() {
  const categories: SettingsCategory[] = [];
  const pages: SettingsPageDef[] = [];
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const byOrder = <T extends { order?: number }>(list: T[]): T[] =>
    list
      .map((item, index) => ({ item, index }))
      .sort(
        (a, b) =>
          (a.item.order ?? 100) - (b.item.order ?? 100) || a.index - b.index,
      )
      .map(({ item }) => item);

  return {
    addCategory(category: SettingsCategory): void {
      if (categories.some((c) => c.id === category.id)) return;
      categories.push(category);
      emit();
    },
    addPage(page: SettingsPageDef): void {
      if (pages.some((p) => p.id === page.id)) return;
      pages.push(page);
      emit();
    },
    removeSource(source: string): void {
      for (const list of [categories, pages]) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i]?.source === source) list.splice(i, 1);
        }
      }
      emit();
    },
    /** ページを持つカテゴリだけの、ツリー。 */
    tree(): SettingsTreeNode[] {
      const known = new Set(categories.map((c) => c.id));
      const nodes: SettingsTreeNode[] = byOrder(categories).map((c) => ({
        ...c,
        pages: byOrder(pages.filter((p) => p.category === c.id)),
      }));
      const orphans = pages.filter((p) => !known.has(p.category));
      if (orphans.length > 0) nodes.push({ ...OTHER, pages: byOrder(orphans) });
      return nodes.filter((node) => node.pages.length > 0);
    },
    find: (id: string): SettingsPageDef | undefined =>
      pages.find((p) => p.id === id),
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type SettingsPages = ReturnType<typeof createSettingsPages>;
