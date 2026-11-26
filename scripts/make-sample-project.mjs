// 確認用のサンプルプロジェクトを作る（specs/007-tree-preview/quickstart.md）。
// 使い方: node scripts/make-sample-project.mjs --out /tmp/unno-sample --assets 300
// 作業状態は DB にあるので、ここで作るのはファイルだけ（状態はアプリで付ける）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** 先頭に置く、種類の見本（件数が少なくても全種類が入る）。 */
const SPECIMENS = [
  { path: "specimen/photo.png", kind: "image" },
  { path: "specimen/notes.txt", kind: "text" },
  { path: "specimen/latin1.txt", kind: "text-not-utf8" },
  { path: "specimen/large.txt", kind: "text-large" },
  { path: "specimen/data.zzz", kind: "unknown" },
  { path: "specimen/broken.png", kind: "image-broken" },
];

const FOLDERS = ["a", "b", "docs", "docs/sub", "写真", "ＡＢＣ", "z-last"];
const BASES = ["img1", "img2", "img10", "IMG3", "メモ", "ＩＭＧ４", "file"];
const EXTS = ["png", "txt", "zzz"];

/** 件数ぶんの相対パスと種類を、決まった順で返す（同じ引数なら同じ結果）。 */
export function sampleEntries(count) {
  const entries = [];
  const used = new Set();
  const add = (path, kind) => {
    if (entries.length < count && !used.has(path)) {
      used.add(path);
      entries.push({ path, kind });
    }
  };
  for (const s of SPECIMENS) add(s.path, s.kind);
  // 自然順を試す名前を、最初に確実に入れる
  add("natural/img2.png", "image");
  add("natural/img10.png", "image");
  add("natural/ＩＭＧ１.png", "image");
  add("natural/メモ.txt", "text");
  let i = 0;
  while (entries.length < count) {
    const folder = FOLDERS[i % FOLDERS.length];
    const base = BASES[Math.floor(i / FOLDERS.length) % BASES.length];
    const ext = EXTS[i % EXTS.length];
    const group = Math.floor(i / (FOLDERS.length * BASES.length));
    // 1 つのフォルダに数千件が並ぶように、深さを抑えて番号を足す
    const sub = group > 0 ? `${folder}/g${Math.floor(group / 500)}` : folder;
    const kind = ext === "png" ? "image" : ext === "txt" ? "text" : "unknown";
    add(`${sub}/${base}-${group}-${i}.${ext}`, kind);
    i += 1;
  }
  return entries.slice(0, count);
}

function contentOf(entry, index) {
  switch (entry.kind) {
    case "image":
      return PNG_1X1;
    case "image-broken":
      return Buffer.from("not really a png");
    case "text-not-utf8":
      return Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0xff, 0xfe]);
    case "text-large":
      return Buffer.alloc(11 * 1024 * 1024, "line of sample text\n");
    case "unknown":
      return Buffer.from(`binary-ish ${index}`);
    default:
      return Buffer.from(`sample text ${index}\n日本語の行\n`);
  }
}

export function generateSampleProject(out, count) {
  const made = new Set();
  sampleEntries(count).forEach((entry, index) => {
    const full = join(out, entry.path);
    const dir = dirname(full);
    if (!made.has(dir)) {
      mkdirSync(dir, { recursive: true });
      made.add(dir);
    }
    writeFileSync(full, contentOf(entry, index));
  });
}

function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const out = value("--out");
  const count = Number(value("--assets") ?? "300");
  if (!out || !Number.isInteger(count) || count < 1) {
    console.error(
      "使い方: node scripts/make-sample-project.mjs --out <フォルダ> --assets <件数>",
    );
    process.exit(1);
  }
  const started = Date.now();
  generateSampleProject(out, count);
  console.log(
    `${count} 件を ${out} に作りました（${Date.now() - started} ms）`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
