import type { Context, ContextValue, WhenExpr } from "../types";

function operandValue(expr: WhenExpr, ctx: Pick<Context, "get">): ContextValue {
  switch (expr.kind) {
    case "key":
      return ctx.get(expr.name);
    case "literal":
      return expr.value;
    default:
      return evaluate(expr, ctx);
  }
}

function truthy(value: ContextValue): boolean {
  return value !== null && value !== false && value !== 0 && value !== "";
}

/** 式を評価する。副作用は無い。未設定のキーは偽。 */
export function evaluate(expr: WhenExpr, ctx: Pick<Context, "get">): boolean {
  switch (expr.kind) {
    case "key":
    case "literal":
      return truthy(operandValue(expr, ctx));
    case "not":
      return !evaluate(expr.operand, ctx);
    case "eq":
      return operandValue(expr.left, ctx) === operandValue(expr.right, ctx);
    case "neq":
      return operandValue(expr.left, ctx) !== operandValue(expr.right, ctx);
    case "and":
      return evaluate(expr.left, ctx) && evaluate(expr.right, ctx);
    case "or":
      return evaluate(expr.left, ctx) || evaluate(expr.right, ctx);
  }
}
