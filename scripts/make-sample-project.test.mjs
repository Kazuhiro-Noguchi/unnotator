import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateSampleProject,
  sampleEntries,
} from "./make-sample-project.mjs";

const dirs = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "unno-sample-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function walk(dir, base = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(path).isDirectory()) out.push(...walk(path, rel));
    else out.push(rel);
  }
  return out;
}

describe("sampleEntries", () => {
  it("件数どおりの相対パスを、重複なく返す", () => {
    const entries = sampleEntries(300);
    expect(entries.length).toBe(300);
    expect(new Set(entries.map((e) => e.path)).size).toBe(300);
  });

  it("実行のたびに同じ並びになる", () => {
    expect(sampleEntries(50)).toEqual(sampleEntries(50));
  });

  it("自然順・全角・日本語を試す名前と、種類の違うファイルを含む", () => {
    const paths = sampleEntries(300).map((e) => e.path);
    expect(paths.some((p) => /img2\./.test(p))).toBe(true);
    expect(paths.some((p) => /img10\./.test(p))).toBe(true);
    expect(paths.some((p) => /[Ａ-Ｚ]/.test(p))).toBe(true);
    expect(paths.some((p) => /[぀-ヿ一-鿿]/.test(p))).toBe(true);
    const kinds = new Set(sampleEntries(300).map((e) => e.kind));
    for (const kind of [
      "image",
      "text",
      "text-not-utf8",
      "text-large",
      "unknown",
      "image-broken",
    ]) {
      expect(kinds.has(kind)).toBe(true);
    }
  });

  it("件数が少なくても、種類の見本をすべて含む", () => {
    expect(sampleEntries(10).length).toBe(10);
    const kinds = new Set(sampleEntries(10).map((e) => e.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(6);
  });
});

describe("generateSampleProject", () => {
  it("ファイルを書き出し、種類ごとの中身の条件を満たす", () => {
    const out = temp();
    generateSampleProject(out, 40);
    const files = walk(out);
    expect(files.length).toBe(40);
    const large = files.find((f) => f.includes("large"));
    expect(statSync(join(out, large)).size).toBeGreaterThan(10 * 1024 * 1024);
    const bad = files.find((f) => f.includes("latin1"));
    const bytes = readFileSync(join(out, bad));
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ).toThrow();
  });

  it("既にあるファイルは上書きしても件数が増えない", () => {
    const out = temp();
    generateSampleProject(out, 20);
    generateSampleProject(out, 20);
    expect(walk(out).length).toBe(20);
  });
});
