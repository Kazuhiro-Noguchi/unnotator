// 編集可能な要素（入力欄など）かどうかの判定。キー入力の入口とコンテキストの `inputFocus` が使う。

interface ElementLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  type?: unknown;
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "radio",
  "range",
  "submit",
  "reset",
  "image",
  "file",
  "color",
]);

export function isEditableTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const el = target as ElementLike;
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    return !(typeof el.type === "string" && NON_TEXT_INPUT_TYPES.has(el.type));
  }
  return false;
}
