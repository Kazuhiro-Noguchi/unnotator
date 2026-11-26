// エクスプローラーの操作（開閉・フォーカス・キー・開く）。DOM に触れない。
// 画面（Explorer.tsx）はこのストアを購読して描く。specs/007-tree-preview/data-model.md の `ExplorerState`。
import type { CurrentStore } from "./current";
import { EMPTY_FILTER, isEmptyFilter, normalizeFilter } from "./filter";
import { type ExplorerPersist, folderKeyToText } from "./persist";
import type { RowsStore } from "./rows";
import type { NodeKey, TreeFilter, TreeRow, ViewSpec } from "./types";

export interface ExplorerSnapshot {
  focus: number;
  /** 開いているフォルダ（符号化した鍵）。 */
  expanded: ReadonlySet<string>;
  filter: TreeFilter;
}

export interface ExplorerController {
  snapshot(): ExplorerSnapshot;
  subscribe(listener: () => void): () => void;
  /** 保存された開閉を取り込んで、見え方を設定する。プロジェクトを開いたあとに 1 回。 */
  start(saved: readonly NodeKey[]): Promise<void>;
  /** プロジェクトを閉じたとき。開閉・フォーカスを捨てて、行を空にする。 */
  reset(): Promise<void>;
  /** アセットの増減のあと。開閉・フォーカス・スクロールを保ったまま、窓を取り直す。 */
  refresh(): Promise<void>;
  /** 描画している範囲 `[start, end)` を伝える。足りない行を取る。 */
  setViewport(start: number, end: number): Promise<void>;
  /** 絞り込みの条件を設定する（空なら解除）。 */
  setFilter(filter: TreeFilter): Promise<void>;
  setFocus(index: number): void;
  toggle(row: TreeRow): Promise<void>;
  /** アセットを開く・フォルダを開閉する。 */
  activate(index: number): Promise<void>;
  /** キー操作。扱ったら `true`（既定の動作を止める）。 */
  key(event: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
  }): boolean;
}

export interface ControllerDeps {
  rows: RowsStore;
  current: CurrentStore;
  /** 開いているプロジェクトの保存先。プロジェクトを閉じているあいだは `null`。 */
  persist?: () => ExplorerPersist | null;
  /** 先頭文字の検索の入力をまとめる時間（ミリ秒）。 */
  typeaheadMs?: number;
}

function folderKeyOf(row: TreeRow): NodeKey | null {
  if (row.kind === "root") return { root_key: row.root_key, path: "" };
  if (row.kind === "folder") return { root_key: row.root_key, path: row.path };
  return null;
}

function nameOf(row: TreeRow): string {
  return "name" in row ? row.name : "";
}

export function createExplorerController(
  deps: ControllerDeps,
): ExplorerController {
  const { rows, current } = deps;
  const typeaheadMs = deps.typeaheadMs ?? 700;
  const expanded = new Map<string, NodeKey>();
  let focus = 0;
  let filter: TreeFilter = EMPTY_FILTER;
  let viewport = { start: 0, end: 30 };
  let typed = "";
  let typedAt = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const spec = (): ViewSpec => ({
    filter,
    expanded_folders: [...expanded.values()],
    expanded_assets: [],
    // 条件から外れても、開いているアセットは現在位置として残す。
    pinned: isEmptyFilter(filter) ? null : (current.get()?.assetId ?? null),
  });

  const save = () => deps.persist?.()?.save([...expanded.values()]);

  async function applyViewChange(): Promise<void> {
    await rows.setView(spec(), { keepPages: true });
    await rows.ensure(viewport.start, viewport.end);
    notify();
  }

  const clampFocus = (index: number) =>
    Math.max(0, Math.min(index, Math.max(0, rows.total() - 1)));

  function moveFocus(index: number): void {
    const next = clampFocus(index);
    if (next === focus) return;
    focus = next;
    notify();
  }

  async function toggle(row: TreeRow): Promise<void> {
    const key = folderKeyOf(row);
    if (!key) return;
    const encoded = folderKeyToText(key);
    if (expanded.has(encoded)) expanded.delete(encoded);
    else expanded.set(encoded, key);
    save();
    await applyViewChange();
  }

  /** 先頭文字の検索: 取得済みの行から、フォーカスの次を探す。 */
  function typeahead(char: string, now: number): boolean {
    typed = now - typedAt > typeaheadMs ? char : typed + char;
    typedAt = now;
    const needle = typed.toLowerCase();
    const total = rows.total();
    // 同じ文字を続けて打ったときは、次の候補へ進む。
    const startFrom = typed.length === 1 ? focus + 1 : focus;
    for (let step = 0; step < total; step += 1) {
      const index = (startFrom + step) % total;
      const row = rows.rowAt(index);
      if (row && nameOf(row).toLowerCase().startsWith(needle)) {
        moveFocus(index);
        return true;
      }
    }
    return false;
  }

  function parentIndex(index: number): number {
    const row = rows.rowAt(index);
    if (!row || !("depth" in row)) return index;
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = rows.rowAt(i);
      if (candidate && "depth" in candidate && candidate.depth < row.depth)
        return i;
    }
    return index;
  }

  /** 開いたアセットが見える位置まで、フォルダを開いてフォーカスを移す（FR-020）。 */
  async function reveal(assetId: string): Promise<void> {
    let located = await rows.locate(assetId);
    if (located === null) return;
    const closed = located.ancestors.filter(
      (key) => !expanded.has(folderKeyToText(key)),
    );
    if (closed.length > 0 && isEmptyFilter(filter)) {
      for (const key of closed) expanded.set(folderKeyToText(key), key);
      save();
      await applyViewChange();
      located = await rows.locate(assetId);
      if (located === null) return;
    }
    if (located.row !== null && located.row !== undefined)
      moveFocus(located.row);
  }

  // 別のアセットを開いたら、見える位置へ。絞り込み中は、残す対象（現在位置）も更新する。
  current.subscribe(() => {
    const target = current.get();
    const refresh = isEmptyFilter(filter)
      ? Promise.resolve()
      : applyViewChange();
    void refresh
      .then(() => (target ? reveal(target.assetId) : undefined))
      .catch(() => {});
  });

  const self: ExplorerController = {
    snapshot: () => ({ focus, expanded: new Set(expanded.keys()), filter }),
    async setFilter(next) {
      filter = normalizeFilter(next);
      focus = 0;
      await applyViewChange();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(saved) {
      expanded.clear();
      filter = EMPTY_FILTER;
      const keys = saved.length > 0 ? saved : [{ root_key: "", path: "" }];
      for (const key of keys) expanded.set(folderKeyToText(key), key);
      focus = 0;
      await rows.setView(spec());
      await rows.ensure(viewport.start, viewport.end);
      notify();
    },
    async reset() {
      expanded.clear();
      filter = EMPTY_FILTER;
      focus = 0;
      rows.clear();
      notify();
    },
    async refresh() {
      await rows.refresh();
      await rows.ensure(viewport.start, viewport.end);
      focus = clampFocus(focus);
      notify();
    },
    async setViewport(start, end) {
      viewport = { start, end };
      // 行が届けば、`rows` の購読者に知らされる。ここでは知らせない（描画の効果が回り続けるため）。
      await rows.ensure(start, end);
    },
    setFocus: moveFocus,
    toggle,
    async activate(index) {
      const row = rows.rowAt(index);
      if (!row) return;
      moveFocus(index);
      if (row.kind === "asset") {
        current.open({
          assetId: row.id,
          itemKey: null,
          mediaType: row.media_type ?? null,
        });
      } else {
        await toggle(row);
      }
    },
    key(event) {
      if (event.ctrlKey || event.metaKey || event.altKey) return false;
      const row = rows.rowAt(focus);
      switch (event.key) {
        case "ArrowDown":
          moveFocus(focus + 1);
          return true;
        case "ArrowUp":
          moveFocus(focus - 1);
          return true;
        case "Home":
          moveFocus(0);
          return true;
        case "End":
          moveFocus(rows.total() - 1);
          return true;
        case "ArrowRight": {
          if (!row) return true;
          const key = folderKeyOf(row);
          if (key && !expanded.has(folderKeyToText(key))) void toggle(row);
          else if (key) moveFocus(focus + 1);
          return true;
        }
        case "ArrowLeft": {
          if (!row) return true;
          const key = folderKeyOf(row);
          if (key && expanded.has(folderKeyToText(key))) void toggle(row);
          else moveFocus(parentIndex(focus));
          return true;
        }
        case "Enter":
        case " ":
          void self.activate(focus);
          return true;
        default:
          if (event.key.length === 1 && event.key.trim() !== "") {
            return typeahead(event.key, Date.now());
          }
          return false;
      }
    },
  };
  return self;
}
