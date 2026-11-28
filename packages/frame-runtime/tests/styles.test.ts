// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseStyles, applyTheme, BASE_CSS } from "../src/styles";

afterEach(() => {
  document.adoptedStyleSheets = [];
  document.documentElement.removeAttribute("style");
});

describe("枠の中の CSS（S-02: <style> と <link> は製品の CSP で使えない）", () => {
  it("基本のスタイルは adoptedStyleSheets で入れ、<style>・<link> を作らない", () => {
    applyBaseStyles(document);
    expect(document.adoptedStyleSheets).toHaveLength(1);
    expect(document.querySelectorAll("style, link")).toHaveLength(0);
  });

  it("基本のスタイルは、本体の色の変数（--color-*）を使い、余白を消す", () => {
    expect(BASE_CSS).toContain("var(--color-bg");
    expect(BASE_CSS).toContain("var(--color-fg");
    expect(BASE_CSS).toMatch(/margin:\s*0/);
  });

  it("2 回呼んでも、重ならない", () => {
    applyBaseStyles(document);
    applyBaseStyles(document);
    expect(document.adoptedStyleSheets).toHaveLength(1);
  });

  it("adoptedStyleSheets が使えなくても、CSSOM（style プロパティ）で最小限を当てる", () => {
    const fake = {
      documentElement: document.documentElement,
      body: document.body,
    } as unknown as Document;
    applyBaseStyles(fake);
    expect(document.body.style.margin).toBe("0px");
  });

  it("テーマの色の変数は CSSOM で設定し、更新で置き換わる（属性の style を使わない）", () => {
    applyTheme(document, { "--color-bg": "#fff", "--color-fg": "#000" });
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe(
      "#fff",
    );
    applyTheme(document, { "--color-bg": "#111" });
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe(
      "#111",
    );
  });

  it("-- で始まらない名前と、制御文字を含む値は受け付けない", () => {
    applyTheme(document, {
      "background-image": "url(x)",
      "--color-x": "red;}body{display:none",
      "--color-ok": "#abc",
    });
    const style = document.documentElement.style;
    expect(style.getPropertyValue("background-image")).toBe("");
    expect(style.getPropertyValue("--color-x")).toBe("");
    expect(style.getPropertyValue("--color-ok")).toBe("#abc");
  });
});
