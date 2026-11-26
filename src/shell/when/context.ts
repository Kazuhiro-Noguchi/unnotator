// コンテキスト: when 式が参照する名前つきの値（specs/006-shell-layout/data-model.md）。
// 読んだキーを追跡して、変わったときだけ再計算する小さな仕組みを持つ。
import type { Context, ContextValue, Watch } from "../types";

/** コアが設定するキーと初期値。 */
const CORE_DEFAULTS: Record<string, ContextValue> = {
  projectOpen: false,
  projectDirty: false,
  canUndo: false,
  canRedo: false,
  focusRegion: "editor",
  inputFocus: false,
  theme: "light",
  language: "ja",
  primarySidebarVisible: true,
  secondarySidebarVisible: true,
  bottomVisible: false,
  primarySidebarView: "explorer",
  // エクスプローラー（007）: アセットを開いているか、フィルターが有効か。
  hasCurrent: false,
  filterActive: false,
};

export const CORE_CONTEXT_KEYS: readonly string[] = Object.keys(CORE_DEFAULTS);

interface Watcher {
  deps: Set<string>;
  recompute(): void;
}

export function createContext(): Context {
  const values = new Map<string, ContextValue>(Object.entries(CORE_DEFAULTS));
  const owned = new Map<string, Set<string>>();
  const watchers = new Set<Watcher>();
  let tracking: Set<string> | null = null;

  function get(key: string): ContextValue {
    tracking?.add(key);
    return values.get(key) ?? null;
  }

  function set(key: string, value: ContextValue): void {
    const before = values.get(key) ?? null;
    if (value === null) values.delete(key);
    else values.set(key, value);
    if (before === value) return;
    for (const watcher of [...watchers]) {
      if (watcher.deps.has(key)) watcher.recompute();
    }
  }

  function setNamespaced(
    owner: string,
    key: string,
    value: ContextValue,
  ): void {
    const full = `${owner}.${key}`;
    let keys = owned.get(owner);
    if (!keys) {
      keys = new Set();
      owned.set(owner, keys);
    }
    keys.add(full);
    set(full, value);
  }

  function remove(owner: string): void {
    const keys = owned.get(owner);
    if (!keys) return;
    owned.delete(owner);
    for (const key of keys) set(key, null);
  }

  function watch<T>(compute: () => T, onChange: (value: T) => void): Watch<T> {
    const run = (): { value: T; deps: Set<string> } => {
      const outer = tracking;
      const deps = new Set<string>();
      tracking = deps;
      try {
        return { value: compute(), deps };
      } finally {
        tracking = outer;
      }
    };
    const first = run();
    let current = first.value;
    const watcher: Watcher = {
      deps: first.deps,
      recompute() {
        const next = run();
        watcher.deps = next.deps;
        if (!Object.is(next.value, current)) {
          current = next.value;
          onChange(next.value);
        }
      },
    };
    watchers.add(watcher);
    return {
      get value() {
        return current;
      },
      dispose() {
        watchers.delete(watcher);
      },
    };
  }

  return { get, set, setNamespaced, remove, watch };
}

/** アプリ全体で 1 つのコンテキスト。 */
export const shellContext: Context = createContext();
