import { describe, expect, it } from "vitest";
import { findHardcodedColors, findHardcodedText } from "./check-theme.mjs";

describe("findHardcodedColors", () => {
  it("16 進・rgb・hsl の直書きを、行番号つきで検出する", () => {
    const hits = findHardcodedColors(
      "a.css",
      ".a { color: #fff; }\n.b { background: rgb(0 0 0); }\n.c { border-color: hsl(10 20% 30%); }\n",
    );
    expect(hits.map((h) => h.line)).toEqual([1, 2, 3]);
  });

  it("CSS の変数の参照は、検出しない", () => {
    expect(
      findHardcodedColors("a.css", ".a { color: var(--color-fg); }"),
    ).toEqual([]);
  });

  it("色名の直書きを、色の指定の中で検出する", () => {
    expect(findHardcodedColors("a.css", ".a { color: red; }").length).toBe(1);
    expect(
      findHardcodedColors("a.css", ".a { background: white; }").length,
    ).toBe(1);
    expect(
      findHardcodedColors("a.css", ".a { border: 1px solid black; }").length,
    ).toBe(1);
  });

  it("currentcolor・transparent・inherit は許す", () => {
    expect(
      findHardcodedColors(
        "a.css",
        ".a { stroke: currentcolor; fill: none; background: transparent; }",
      ),
    ).toEqual([]);
  });

  it(".tsx の中の色も検出する（style の文字列）", () => {
    expect(
      findHardcodedColors("a.tsx", 'const s = { color: "#ff0000" };').length,
    ).toBe(1);
  });

  it("色に関係ない # や、単語の一部は検出しない", () => {
    expect(
      findHardcodedColors("a.tsx", 'const a = "#anchor"; // issue #12 redo')
        .length,
    ).toBe(0);
    expect(findHardcodedColors("a.css", '.a { content: "hundred"; }')).toEqual(
      [],
    );
  });
});

describe("findHardcodedText", () => {
  it("JSX の中の直書きの文言を検出する（日本語・英語）", () => {
    const hits = findHardcodedText(
      "a.tsx",
      "<div>保存</div>\n<p>Save the file</p>\n",
    );
    expect(hits.map((h) => h.line)).toEqual([1, 2]);
  });

  it("aria-label・title・placeholder・alt の文字列の直書きを検出する", () => {
    const hits = findHardcodedText(
      "a.tsx",
      '<a aria-label="閉じる" />\n<a title="Close" />\n<a placeholder="Search" />\n<a alt="x" />',
    );
    expect(hits.length).toBe(4);
  });

  it("t() や式の参照は検出しない", () => {
    const source =
      '<div>{t("a.b")}</div>\n<button aria-label={t("x")} title={label()}>{props.text}</button>\n<span class="a b">{x}</span>';
    expect(findHardcodedText("a.tsx", source)).toEqual([]);
  });

  it("記号だけの文言（● など）は許す", () => {
    expect(
      findHardcodedText("a.tsx", "<span>●</span><span>✓</span><span>⚠ </span>"),
    ).toEqual([]);
  });

  it("行末のコメントは対象にしない", () => {
    expect(findHardcodedText("a.tsx", "const a = 1; // 余白")).toEqual([]);
  });

  it(".ts のファイルや、コメントは対象にしない", () => {
    expect(findHardcodedText("a.ts", "const a = '<div>保存</div>'")).toEqual(
      [],
    );
    expect(
      findHardcodedText("a.tsx", "{/* 保存 */}\n// <div>保存</div>"),
    ).toEqual([]);
  });
});
