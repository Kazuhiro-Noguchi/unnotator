// 汎用プレビューの種類の判定（specs/007-tree-preview/research.md R7）。
// 媒体種別の登録簿ではなく、プレビュー自身の「拡張子 → 種類」の表で決める
// （媒体種別を持たないアセットにも、プレビューは出るため）。表示専用。
// PDF は表示しない（注釈を付けるなら、拡張機能のエディターが自前で描く。不明形式と同じ案内にする）。

export type PreviewKind = "image" | "text" | "unknown";

const IMAGE = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "svg",
]);
const TEXT = new Set([
  "txt",
  "md",
  "json",
  "jsonl",
  "csv",
  "tsv",
  "log",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
]);

/** パスの最後の部分の、最後の拡張子で決める（大文字小文字を区別しない）。 */
export function choosePreviewKind(relPath: string): PreviewKind {
  const name = relPath.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  // 拡張子が無い・先頭だけの点（.hidden）・末尾の点は、不明形式。
  if (dot <= 0 || dot === name.length - 1) return "unknown";
  const ext = name.slice(dot + 1).toLowerCase();
  if (IMAGE.has(ext)) return "image";
  if (TEXT.has(ext)) return "text";
  return "unknown";
}
