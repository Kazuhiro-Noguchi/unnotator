// 色と文字の直書きの検査（憲章のゲート「i18n とテーマ」、specs/006-shell-layout の SC-006）。
// 色はテーマの CSS 変数だけ、画面の文字は i18n（ja.json・en.json）だけにする。`pnpm lint` から呼ぶ。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCAN_DIRS = ["src"];
// テーマのトークンの定義（色を書く唯一の場所）と、生成物・テストは対象外。
const SKIP_PREFIXES = ["src/themes/", "src/ipc/"];
const SKIP_SUFFIXES = [".test.ts", ".test.tsx"];

const NAMED_COLORS = new Set([
  "red",
  "green",
  "blue",
  "white",
  "black",
  "gray",
  "grey",
  "yellow",
  "orange",
  "purple",
  "pink",
  "brown",
  "cyan",
  "magenta",
  "silver",
  "gold",
  "navy",
  "teal",
  "lime",
  "maroon",
  "olive",
  "aqua",
  "fuchsia",
]);

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/;
const FUNCTION_COLOR = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;
const COLOR_PROPERTY =
  /\b(?:color|background(?:-color)?|border(?:-[a-z]+)*|outline(?:-[a-z]+)*|fill|stroke|box-shadow|text-shadow|text-decoration(?:-color)?)\s*:\s*([^;}\n]*)/g;

/** 行ごとに、コメントを除いた文字列を返す（行番号を保つ）。 */
function codeLines(source) {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  return noBlock.split(/\r?\n/).map((line) => {
    if (line.trimStart().startsWith("//")) return "";
    // 行末の `// ...` のコメント（引用符の外にあるものだけ）。
    const at = line.search(/\s\/\/(?!\/)/);
    if (at >= 0 && (line.slice(0, at).match(/["'`]/g) ?? []).length % 2 === 0) {
      return line.slice(0, at);
    }
    return line;
  });
}

export function findHardcodedColors(file, source) {
  const hits = [];
  codeLines(source).forEach((text, index) => {
    const line = index + 1;
    if (HEX.test(text) || FUNCTION_COLOR.test(text)) {
      hits.push({ file, line, kind: "color" });
      return;
    }
    for (const match of text.matchAll(COLOR_PROPERTY)) {
      const words = (match[1] ?? "").toLowerCase().split(/[^a-z]+/);
      if (words.some((word) => NAMED_COLORS.has(word))) {
        hits.push({ file, line, kind: "color" });
        break;
      }
    }
  });
  return hits;
}

const CJK = /[぀-ヿ㐀-鿿]/;
const ENGLISH_JSX_TEXT = />\s*[A-Z][a-z]+[^<>{}]*</;
const TEXT_ATTRIBUTE =
  /\b(?:aria-label|title|placeholder|alt)="[^"]*[\p{L}][^"]*"/u;

export function findHardcodedText(file, source) {
  if (!file.endsWith(".tsx")) return [];
  const hits = [];
  codeLines(source).forEach((text, index) => {
    if (
      CJK.test(text) ||
      ENGLISH_JSX_TEXT.test(text) ||
      TEXT_ATTRIBUTE.test(text)
    ) {
      hits.push({ file, line: index + 1, kind: "text" });
    }
  });
  return hits;
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
        SKIP_PREFIXES.some((p) => relative.startsWith(p)) ||
        SKIP_SUFFIXES.some((s) => relative.endsWith(s)) ||
        ![".ts", ".tsx", ".css"].some((e) => path.endsWith(e))
      ) {
        continue;
      }
      const source = readFileSync(path, "utf8");
      hits.push(
        ...findHardcodedColors(relative, source),
        ...findHardcodedText(relative, source),
      );
    }
  }
  for (const hit of hits) {
    const what =
      hit.kind === "color"
        ? "色の直書き。テーマの CSS 変数（--color-*）を使う"
        : "文字の直書き。i18n（ja.json・en.json）を使う";
    console.error(`${hit.file}:${hit.line}: ${what}`);
  }
  if (hits.length > 0) process.exit(1);
  console.log("色・文字の直書きの検査: 問題なし");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
