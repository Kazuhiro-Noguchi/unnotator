import { describe, expect, it } from "vitest";
import { choosePreviewKind } from "./choose";

describe("choosePreviewKind", () => {
  it("画像の拡張子（大文字小文字を区別しない）", () => {
    for (const name of [
      "a.png",
      "A.PNG",
      "x/y.jpg",
      "z.JPEG",
      "g.gif",
      "w.webp",
      "v.avif",
      "b.bmp",
      "i.ico",
      "s.svg",
    ]) {
      expect(choosePreviewKind(name), name).toBe("image");
    }
  });

  it("テキストの拡張子", () => {
    for (const name of [
      "a.txt",
      "r.md",
      "d.json",
      "l.jsonl",
      "t.csv",
      "t.tsv",
      "x.log",
      "p.xml",
      "c.yaml",
      "c.yml",
      "c.toml",
      "c.ini",
    ]) {
      expect(choosePreviewKind(name), name).toBe("text");
    }
  });

  it("それ以外は、不明形式", () => {
    for (const name of [
      "a.zzz",
      "noext",
      ".hidden",
      "a.",
      "archive.tar.gz",
      "dir.png/file",
    ]) {
      expect(choosePreviewKind(name), name).toBe("unknown");
    }
  });

  it("最後の拡張子で決める", () => {
    expect(choosePreviewKind("a.txt.png")).toBe("image");
    expect(choosePreviewKind("a.png.txt")).toBe("text");
  });

  it("フォルダの名前の拡張子は見ない（パスの最後の部分だけ）", () => {
    expect(choosePreviewKind("photos.png/readme")).toBe("unknown");
    expect(choosePreviewKind("photos.png\\readme.md")).toBe("text");
  });
});
