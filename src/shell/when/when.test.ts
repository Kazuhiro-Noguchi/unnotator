import { describe, expect, it } from "vitest";
import { makeProblemSink } from "../testing/fakes";
import type { ContextValue } from "../types";
import { evaluate } from "./eval";
import { createWhen, parseWhen, parseWhenCached } from "./parse";

function ctxOf(values: Record<string, ContextValue>) {
  return {
    get: (key: string): ContextValue => values[key] ?? null,
  };
}

function check(source: string, values: Record<string, ContextValue> = {}) {
  const parsed = parseWhen(source);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.error.message}`);
  return evaluate(parsed.expr, ctxOf(values));
}

describe("when 式の文法と評価", () => {
  it("キーだけの式は、値が真と見なせるかで決まる", () => {
    expect(check("a", { a: true })).toBe(true);
    expect(check("a", { a: false })).toBe(false);
    expect(check("a", { a: 1 })).toBe(true);
    expect(check("a", { a: 0 })).toBe(false);
    expect(check("a", { a: "x" })).toBe(true);
    expect(check("a", { a: "" })).toBe(false);
    expect(check("a", { a: null })).toBe(false);
  });

  it("未設定のキーは偽で、エラーにならない", () => {
    expect(check("nothing")).toBe(false);
    expect(check("!nothing")).toBe(true);
    expect(check("nothing == 'x'")).toBe(false);
    expect(check("nothing != 'x'")).toBe(true);
  });

  it("真偽値・数値・文字列のリテラルを使える", () => {
    expect(check("true")).toBe(true);
    expect(check("false")).toBe(false);
    expect(check("n == 3", { n: 3 })).toBe(true);
    expect(check("n == 3.5", { n: 3.5 })).toBe(true);
    expect(check("s == 'x'", { s: "x" })).toBe(true);
    expect(check('s == "x"', { s: "x" })).toBe(true);
    expect(check("'x' == s", { s: "x" })).toBe(true);
  });

  it("== と != は型をそろえず厳密に比べ、大文字小文字を区別する", () => {
    expect(check("n == '3'", { n: 3 })).toBe(false);
    expect(check("s == 'X'", { s: "x" })).toBe(false);
    expect(check("b == true", { b: true })).toBe(true);
    expect(check("b == 1", { b: true })).toBe(false);
    expect(check("a != b", { a: "x", b: "y" })).toBe(true);
  });

  it("引用符の中に演算子や空白があってもよい", () => {
    expect(check("s == 'a && b'", { s: "a && b" })).toBe(true);
    expect(check("s == ' '", { s: " " })).toBe(true);
  });

  it("優先順位は ! > == != > && > || で、括弧で変えられる", () => {
    expect(check("a || b && c", { a: true, b: false, c: false })).toBe(true);
    expect(check("(a || b) && c", { a: true, b: false, c: false })).toBe(false);
    expect(check("!a && b", { a: false, b: true })).toBe(true);
    expect(check("!(a && b)", { a: true, b: false })).toBe(true);
    expect(check("!a == b", { a: false, b: true })).toBe(true);
    expect(check("!!a", { a: true })).toBe(true);
  });

  it("名前にドット・アンダースコアを含められる", () => {
    expect(check("selection.type == 'x'", { "selection.type": "x" })).toBe(
      true,
    );
    expect(
      check("com.example.ext_1.flag", { "com.example.ext_1.flag": true }),
    ).toBe(true);
  });

  it("設計書の例の式を評価できる", () => {
    const expr =
      "activeEditor == 'com.example.image/editor' && selection.type == 'com.example.image-rect/rect'";
    expect(
      check(expr, {
        activeEditor: "com.example.image/editor",
        "selection.type": "com.example.image-rect/rect",
      }),
    ).toBe(true);
    expect(
      check(expr, {
        activeEditor: "com.example.image/editor",
        "selection.type": "x",
      }),
    ).toBe(false);
  });

  it("空白の量や改行は結果に影響しない", () => {
    expect(check("  a   &&\n b ", { a: true, b: true })).toBe(true);
  });
});

describe("構文エラー", () => {
  const bad = [
    "",
    "   ",
    "&&",
    "||",
    "a &&",
    "&& a",
    "a ||",
    "a &",
    "a |",
    "a = b",
    "a == ",
    "== a",
    "a ==",
    "a != != b",
    "(a",
    "a)",
    "()",
    "(a && b",
    "!",
    "a b",
    "a 'x'",
    "'abc",
    '"abc',
    "a == 'x",
    "1.2.3 == a",
    "a == @",
    "a $ b",
    "a && (b ||)",
    "a == b == c",
    ".a",
    "a..b == 1",
    "-",
  ];

  it.each(bad)("%j は構文エラーで、位置を返す", (source) => {
    const parsed = parseWhen(source);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message.length).toBeGreaterThan(0);
      expect(parsed.error.offset).toBeGreaterThanOrEqual(0);
      expect(parsed.error.offset).toBeLessThanOrEqual(source.length);
    }
  });

  it("エラーの位置が、最初の不正な箇所を指す", () => {
    const parsed = parseWhen("a && )");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.offset).toBe(5);
  });
});

describe("createWhen", () => {
  it("式が無い・空のときは、常に真", () => {
    const { sink, problems } = makeProblemSink();
    expect(createWhen(undefined, ctxOf({}), sink, "t")()).toBe(true);
    expect(createWhen("", ctxOf({}), sink, "t")()).toBe(true);
    expect(problems).toEqual([]);
  });

  it("誤った式は偽を返し、when.syntax を 1 回だけ報告する", () => {
    const { sink, problems } = makeProblemSink();
    const fn = createWhen("a &&", ctxOf({ a: true }), sink, "ext.x");
    expect(fn()).toBe(false);
    expect(fn()).toBe(false);
    expect(fn()).toBe(false);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe("when.syntax");
    expect(problems[0]?.source).toBe("ext.x");
  });

  it("評価するたびに最新のコンテキストを読む", () => {
    const { sink } = makeProblemSink();
    const values: Record<string, ContextValue> = { a: false };
    const fn = createWhen("a", ctxOf(values), sink, "t");
    expect(fn()).toBe(false);
    values.a = true;
    expect(fn()).toBe(true);
  });
});

describe("パースのキャッシュ", () => {
  it("同じ式は同じ結果のオブジェクトを返す", () => {
    const first = parseWhenCached("a && b");
    const second = parseWhenCached("a && b");
    expect(second).toBe(first);
  });
});
