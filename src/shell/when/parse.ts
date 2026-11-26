// when 式の字句解析と構文解析（specs/006-shell-layout/research.md R2）。
// 文法（優先順位の低い順）:
//   or      := and ("||" and)*
//   and     := eq ("&&" eq)*
//   eq      := unary (("==" | "!=") unary)?     // 連続した比較は構文エラー
//   unary   := "!" unary | primary
//   primary := ident | number | string | "true" | "false" | "(" or ")"
import type { Context, ProblemSink, WhenExpr } from "../types";
import { evaluate } from "./eval";

export interface WhenError {
  message: string;
  offset: number;
}
export type ParseResult =
  | { ok: true; expr: WhenExpr }
  | { ok: false; error: WhenError };

type Token =
  | { type: "ident"; value: string; offset: number }
  | { type: "number"; value: number; offset: number }
  | { type: "string"; value: string; offset: number }
  | {
      type: "op";
      value: "!" | "==" | "!=" | "&&" | "||" | "(" | ")";
      offset: number;
    }
  | { type: "end"; offset: number };

class SyntaxFailure extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/;
const NUMBER = /^\d+(?:\.\d+)?/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? "";
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "&&" || two === "||") {
      tokens.push({ type: "op", value: two, offset: i });
      i += 2;
      continue;
    }
    if (ch === "!" || ch === "(" || ch === ")") {
      tokens.push({ type: "op", value: ch, offset: i });
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = source.indexOf(ch, i + 1);
      if (end < 0) throw new SyntaxFailure("文字列が閉じられていない", i);
      tokens.push({
        type: "string",
        value: source.slice(i + 1, end),
        offset: i,
      });
      i = end + 1;
      continue;
    }
    const rest = source.slice(i);
    const num = NUMBER.exec(rest);
    if (num) {
      tokens.push({ type: "number", value: Number(num[0]), offset: i });
      i += num[0].length;
      continue;
    }
    const ident = IDENT.exec(rest);
    if (ident) {
      tokens.push({ type: "ident", value: ident[0], offset: i });
      i += ident[0].length;
      continue;
    }
    throw new SyntaxFailure(`使えない文字: ${ch}`, i);
  }
  tokens.push({ type: "end", offset: source.length });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos] ?? { type: "end", offset: 0 };
  }

  private isOp(value: string): boolean {
    const token = this.peek();
    return token.type === "op" && token.value === value;
  }

  parse(): WhenExpr {
    const expr = this.or();
    const token = this.peek();
    if (token.type !== "end") {
      throw new SyntaxFailure("式の途中に余計なものがある", token.offset);
    }
    return expr;
  }

  private or(): WhenExpr {
    let left = this.and();
    while (this.isOp("||")) {
      this.pos++;
      left = { kind: "or", left, right: this.and() };
    }
    return left;
  }

  private and(): WhenExpr {
    let left = this.eq();
    while (this.isOp("&&")) {
      this.pos++;
      left = { kind: "and", left, right: this.eq() };
    }
    return left;
  }

  private eq(): WhenExpr {
    const left = this.unary();
    if (this.isOp("==") || this.isOp("!=")) {
      const kind = this.isOp("==") ? "eq" : "neq";
      this.pos++;
      return { kind, left, right: this.unary() };
    }
    return left;
  }

  private unary(): WhenExpr {
    if (this.isOp("!")) {
      this.pos++;
      return { kind: "not", operand: this.unary() };
    }
    return this.primary();
  }

  private primary(): WhenExpr {
    const token = this.peek();
    switch (token.type) {
      case "ident":
        this.pos++;
        if (token.value === "true") return { kind: "literal", value: true };
        if (token.value === "false") return { kind: "literal", value: false };
        return { kind: "key", name: token.value };
      case "number":
      case "string":
        this.pos++;
        return { kind: "literal", value: token.value };
      case "op":
        if (token.value === "(") {
          this.pos++;
          const inner = this.or();
          if (!this.isOp(")")) {
            throw new SyntaxFailure("閉じ括弧が無い", this.peek().offset);
          }
          this.pos++;
          return inner;
        }
        throw new SyntaxFailure("ここには式が必要", token.offset);
      default:
        throw new SyntaxFailure("式が途中で終わっている", token.offset);
    }
  }
}

export function parseWhen(source: string): ParseResult {
  try {
    return { ok: true, expr: new Parser(tokenize(source)).parse() };
  } catch (error) {
    if (error instanceof SyntaxFailure) {
      return {
        ok: false,
        error: { message: error.message, offset: error.offset },
      };
    }
    throw error;
  }
}

const cache = new Map<string, ParseResult>();

/** 同じ式のパースを 1 回にする。 */
export function parseWhenCached(source: string): ParseResult {
  const hit = cache.get(source);
  if (hit) return hit;
  const result = parseWhen(source);
  cache.set(source, result);
  return result;
}

/**
 * 式から「いまの真偽」を返す関数を作る。式が無いか空なら常に真。
 * 構文エラーは偽にして、`when.syntax` を 1 回だけ報告する。
 */
export function createWhen(
  source: string | undefined,
  ctx: Pick<Context, "get">,
  report: ProblemSink,
  owner: string,
): () => boolean {
  if (source === undefined || source.trim() === "") return () => true;
  const parsed = parseWhenCached(source);
  if (!parsed.ok) {
    report({
      code: "when.syntax",
      source: owner,
      message: `when 式が正しくない: ${source}`,
      detail: `${parsed.error.message}（位置 ${parsed.error.offset}）`,
    });
    return () => false;
  }
  const { expr } = parsed;
  return () => evaluate(expr, ctx);
}
