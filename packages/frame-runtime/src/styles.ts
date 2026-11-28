// 枠の中の CSS。製品の CSP では `<style>` 本文と、枠の CSP の外の `<link>` は使えない（S-02）。
// `fetch` も `connect-src 'none'` で止まる。使えるのは、CSSOM（`adoptedStyleSheets`・`style.setProperty`）だけ。
// 拡張機能自身の CSS は、自分のフォルダの `<link rel="stylesheet">` で読める（枠の `style-src` が自分のパスだけを許す）。

/** 枠の基本のスタイル。本体の色の変数（`--color-*`）が使える。 */
export const BASE_CSS = `
html, body { margin: 0; padding: 0; height: 100%; }
body {
  background: var(--color-bg, #fff);
  color: var(--color-fg, #000);
  font: 14px/1.5 system-ui, sans-serif;
}
*, *::before, *::after { box-sizing: border-box; }
`;

const NAME = /^--[A-Za-z0-9_-]+$/;
// 値は、宣言を抜け出せる文字（`;` `{` `}` 改行など）を含まないものだけ。
function isSafeValue(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || ";{}<>\\".includes(ch)) return false;
  }
  return true;
}

export function applyBaseStyles(doc: Document): void {
  const adopt = doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] };
  const Sheet = (doc.defaultView ?? globalThis).CSSStyleSheet;
  if (Array.isArray(adopt.adoptedStyleSheets) && typeof Sheet === "function") {
    const sheet = new Sheet();
    sheet.replaceSync(BASE_CSS);
    // 1 つだけ（2 回目は置き換える）。
    adopt.adoptedStyleSheets = [sheet];
    return;
  }
  // 使えない環境の最小限（CSSOM の style プロパティは CSP に止められない）。
  const body = doc.body;
  if (body !== undefined && body !== null) {
    body.style.margin = "0";
    body.style.background = "var(--color-bg)";
    body.style.color = "var(--color-fg)";
  }
}

/** テーマの色の変数をルートに設定する（`style` 属性を書かず、CSSOM で）。 */
export function applyTheme(
  doc: Document,
  variables: Record<string, string>,
): void {
  const style = doc.documentElement.style;
  for (const [name, value] of Object.entries(variables)) {
    if (!NAME.test(name) || typeof value !== "string" || !isSafeValue(value))
      continue;
    style.setProperty(name, value);
  }
}
