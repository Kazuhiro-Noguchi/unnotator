// 既定のエディター（媒体種別 → エディター ID）の保存。プロジェクト設定の `core.editors.default`。
// `get` は同期で返すので、写しを持つ。`load` で読み込み、`set` は写しを先に更新して書き出す。
import type { EditorPreferences } from "./placement";

export interface EditorPreferencesPort {
  read(): Promise<Record<string, string>>;
  write(map: Record<string, string>): Promise<void>;
}

export interface ProjectEditorPreferences extends EditorPreferences {
  /** プロジェクトを開いたとき。設定を読んで写しを作る。読めなければ空。 */
  load(): Promise<void>;
  /** プロジェクトを閉じたとき。 */
  clear(): void;
}

function onlyStrings(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry !== "") out[key] = entry;
  }
  return out;
}

export function createProjectPreferences(
  port: EditorPreferencesPort,
  onError: (error: unknown) => void = () => {},
): ProjectEditorPreferences {
  let map: Record<string, string> = {};
  let queue: Promise<void> = Promise.resolve();
  return {
    get: (mediaType) => map[mediaType],
    set(mediaType, editorId) {
      map = { ...map, [mediaType]: editorId };
      const snapshot = map;
      // 書き込みは順番に行う（後の値が先の値を上書きする）。
      queue = queue
        .then(() => port.write(snapshot))
        .catch((error: unknown) => onError(error));
    },
    async load() {
      try {
        map = onlyStrings(await port.read());
      } catch {
        map = {};
      }
    },
    clear() {
      map = {};
    },
  };
}
