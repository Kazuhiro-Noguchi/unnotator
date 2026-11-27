// リボンの「モード」。いまのモードを 1 つだけ持つ（無ければ `null`）。モードごとに、操作の意味が変わる。
//
// - `fileClassification`（ファイル分類）: 表示中のファイルの分類を、ラベルの選択として扱う。
//   ラベルをクリックすると、そのファイルの分類を変える（`labels/` が使う）。
// コンテキストのキー: `mode`（モードの ID か `null`）と、モードごとの `modeFileClassification`（true / false）。
// 後者が、リボンのトグルの押された状態になる。
import { createSignal } from "solid-js";

export type ModeId = "fileClassification";

const MODE_CONTEXT_KEYS: Record<ModeId, string> = {
  fileClassification: "modeFileClassification",
};

export interface ModeStore {
  /** 反応するスコープの中で読むと、購読が張られる。 */
  get(): ModeId | null;
  set(mode: ModeId | null): void;
  /** そのモードなら切り、そうでなければ、そのモードにする。 */
  toggle(mode: ModeId): void;
  subscribe(listener: () => void): () => void;
}

export function createModeStore(context: {
  set(key: string, value: string | boolean | null): void;
}): ModeStore {
  const [mode, setMode] = createSignal<ModeId | null>(null);
  const listeners = new Set<() => void>();
  const publish = (value: ModeId | null) => {
    context.set("mode", value);
    for (const [id, key] of Object.entries(MODE_CONTEXT_KEYS)) {
      context.set(key, id === value);
    }
  };
  publish(null);
  const set = (value: ModeId | null) => {
    if (mode() === value) return;
    setMode(value);
    publish(value);
    for (const listener of [...listeners]) listener();
  };
  return {
    get: mode,
    set,
    toggle: (id) => set(mode() === id ? null : id),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
