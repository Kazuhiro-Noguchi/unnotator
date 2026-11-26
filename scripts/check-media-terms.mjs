// コアに媒体固有の概念が入っていないことの検査（憲章 I、SC-009、research.md R10）。
// 判断基準は「音声ファイルでも意味があるか」。意味がない語（座標・ピクセル・ズームなど）を機械的に弾く。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 禁止語。大文字小文字は区別しない。記録時刻（created_at など）は媒体の時刻ではないので含めない。 */
export const FORBIDDEN_TERMS = [
  "pixel",
  "zoom",
  "coordinate",
  "bbox",
  "decode",
  "codec",
  "waveform",
  "sample_rate",
  "座標",
  "ピクセル",
  "ズーム",
  "デコード",
];

const SCAN_DIRS = ["crates/core/src", "src-tauri/src", "src"];
const EXTENSIONS = [".rs", ".ts", ".tsx", ".css"];
// 生成物は対象外（元の Rust 側が検査される）。
const SKIP_FILES = new Set(["src/ipc/bindings.ts"]);

export function findForbiddenTerms(file, source) {
  const hits = [];
  source.split(/\r?\n/).forEach((text, index) => {
    const lower = text.toLowerCase();
    for (const term of FORBIDDEN_TERMS) {
      if (lower.includes(term.toLowerCase())) {
        hits.push({ file, line: index + 1, term });
      }
    }
  });
  return hits;
}

/**
 * 憲章 I が認める唯一の例外: 汎用プレビュー（表示専用）。`src/preview/` の中だけを検査から外す。
 * 範囲を広げない（`src/previews/` なども対象のまま）。
 */
export function isExemptPreview(relativePath) {
  return relativePath.replaceAll("\\", "/").startsWith("src/preview/");
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const hits = [];
  for (const dir of SCAN_DIRS) {
    for (const path of walk(join(root, dir))) {
      const relative = path.slice(root.length).replaceAll("\\", "/");
      if (
        SKIP_FILES.has(relative) ||
        isExemptPreview(relative) ||
        !EXTENSIONS.some((e) => path.endsWith(e))
      )
        continue;
      hits.push(...findForbiddenTerms(relative, readFileSync(path, "utf8")));
    }
  }
  for (const hit of hits) {
    console.error(
      `${hit.file}:${hit.line}: 媒体固有の語 "${hit.term}" はコアに置けない（憲章 I）`,
    );
  }
  if (hits.length > 0) process.exit(1);
  console.log("媒体固有の用語の検査: 問題なし");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
