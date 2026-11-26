// 開いたフォルダの保存と復元（利用者の設定 `ui.explorer`。specs/007-tree-preview/research.md R11）。
// プロジェクトのフォルダごとに、最近の 20 件まで。プロジェクトのファイルは書き換えない。
import type { NodeKey } from "./types";

export const MAX_PROJECTS = 20;
const SAVE_DELAY_MS = 500;

export type Persisted = Record<string, string[]>;

/** ルートのキーの `%` と `:` を、区切りと間違えないように置き換える。 */
const escapeRoot = (text: string) =>
  text.replaceAll("%", "%25").replaceAll(":", "%3A");
const unescapeRoot = (text: string) =>
  text.replaceAll("%3A", ":").replaceAll("%25", "%");

/** `<root_key（% と : を置き換えたもの）>:<フォルダの相対パス>`。ルートは相対パスが空。 */
export function folderKeyToText(key: NodeKey): string {
  return `${escapeRoot(key.root_key)}:${key.path}`;
}

export function folderKeyFromText(text: string): NodeKey | null {
  const at = text.indexOf(":");
  if (at < 0) return null;
  return {
    root_key: unescapeRoot(text.slice(0, at)),
    path: text.slice(at + 1),
  };
}

/** 形が違えば捨てる。20 件を超えたら、後ろ（新しい側）の 20 件を残す。 */
export function parsePersisted(value: unknown): Persisted {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const entries: Array<[string, string[]]> = [];
  for (const [folder, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue;
    entries.push([
      folder,
      list.filter((item): item is string => typeof item === "string"),
    ]);
  }
  return Object.fromEntries(entries.slice(-MAX_PROJECTS));
}

/** プロジェクトの記録を、最近使ったものとして後ろに置く。古いものから捨てる。 */
export function remember(
  base: Persisted,
  folder: string,
  keys: readonly NodeKey[],
): Persisted {
  const entries = Object.entries(base).filter(([name]) => name !== folder);
  entries.push([folder, keys.map(folderKeyToText)]);
  return Object.fromEntries(entries.slice(-MAX_PROJECTS));
}

export interface PersistPort {
  read(): Promise<unknown>;
  write(value: Persisted): Promise<void>;
}

export interface ExplorerPersist {
  /** 開いたフォルダを読む。`exists` が偽のものは捨てる。読めなければ空。 */
  load(exists?: (key: NodeKey) => boolean): Promise<NodeKey[]>;
  /** 500 ミリ秒まとめて書く。 */
  save(keys: readonly NodeKey[]): void;
  /** 待たずに書く。失敗しても例外は出さない。 */
  flush(): Promise<void>;
}

export function createExplorerPersist(
  port: PersistPort,
  projectFolder: string,
): ExplorerPersist {
  let stored: Persisted = {};
  let pending: readonly NodeKey[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function write(): Promise<void> {
    if (pending === null) return;
    const keys = pending;
    pending = null;
    stored = remember(stored, projectFolder, keys);
    try {
      await port.write(stored);
    } catch {
      // 画面の状態は失われても、作業は止めない。
    }
  }

  return {
    async load(exists) {
      try {
        stored = parsePersisted(await port.read());
      } catch {
        stored = {};
      }
      const keys: NodeKey[] = [];
      for (const text of stored[projectFolder] ?? []) {
        const key = folderKeyFromText(text);
        if (key && (!exists || exists(key))) keys.push(key);
      }
      return keys;
    },
    save(keys) {
      pending = keys;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void write();
      }, SAVE_DELAY_MS);
    },
    async flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await write();
    },
  };
}
