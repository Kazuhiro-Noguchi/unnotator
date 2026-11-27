// 押せないボタンは、グレーアウトする。ボタンの種類（`.button.<種類>`）を足したら、その `:disabled` の規則も要る。
// 種類ごとに色・背景を決めていると、`.button:disabled` の規則に勝って、押せないのに通常の色に見えるため。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./shell.css", import.meta.url), "utf8");

/** `.button.<種類>` として定義されている種類（`:hover` などの疑似クラスは、種類ではない）。 */
function buttonVariants(source: string): string[] {
  const variants = new Set<string>();
  for (const match of source.matchAll(/\.button\.([a-z][\w-]*)(?![\w-])/g)) {
    variants.add(match[1] as string);
  }
  return [...variants].sort();
}

describe("ボタンの押せない見た目", () => {
  it("ボタンの種類が、検出できている", () => {
    expect(buttonVariants(css)).toEqual(
      expect.arrayContaining(["danger", "icon-button", "primary"]),
    );
  });

  it("すべてのボタンの種類に、:disabled の規則がある（グレーアウトの色を、種類ごとに決める）", () => {
    const missing = buttonVariants(css).filter(
      (variant) => !css.includes(`.button.${variant}:disabled`),
    );
    expect(missing).toEqual([]);
  });

  it("押せないときの文字色は、無効用の色（--color-fg-disabled）", () => {
    const block = css.slice(css.lastIndexOf(".button:disabled,"));
    expect(block).toContain("color: var(--color-fg-disabled)");
  });
});
