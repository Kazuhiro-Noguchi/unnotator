import { describe, expect, it } from "vitest";
import darkCss from "./dark.css?raw";
import lightCss from "./light.css?raw";

function variableNames(css: string): string[] {
  return [
    ...new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] ?? "")),
  ].sort();
}

describe("themes", () => {
  it("light.css と dark.css で CSS 変数の名前の集合が一致する", () => {
    const light = variableNames(lightCss);
    const dark = variableNames(darkCss);
    expect(light.length).toBeGreaterThan(0);
    expect(dark).toEqual(light);
  });
});

// ---- WCAG の対比（specs/006-shell-layout/spec.md SC-007、research.md R10） ----

function tokens(css: string, selector: RegExp): Record<string, string> {
  const block = selector.exec(css)?.[1] ?? "";
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [
      m[1] ?? "",
      (m[2] ?? "").trim(),
    ]),
  );
}

const lightTokens = tokens(
  lightCss,
  /:root,\s*:root\[data-theme="light"\]\s*\{([^}]*)\}/,
);
const darkTokens = tokens(darkCss, /:root\[data-theme="dark"\]\s*\{([^}]*)\}/);
const darkMediaTokens = tokens(
  darkCss,
  /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/,
);

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

// [前景, 背景, 最小の対比]。通常の文字は 4.5、無効の文字・枠・フォーカスの輪は 3。
const PAIRS: Array<[string, string, number]> = [
  ["--color-fg", "--color-bg", 4.5],
  ["--color-fg", "--color-surface", 4.5],
  ["--color-fg", "--color-surface-hover", 4.5],
  ["--color-fg", "--color-surface-active", 4.5],
  ["--color-fg", "--color-selection", 4.5],
  ["--color-fg-muted", "--color-bg", 4.5],
  ["--color-fg-muted", "--color-surface", 4.5],
  ["--color-fg-muted", "--color-surface-hover", 4.5],
  ["--color-fg-disabled", "--color-bg", 3],
  ["--color-fg-disabled", "--color-surface", 3],
  ["--color-accent-fg", "--color-accent", 4.5],
  ["--color-accent", "--color-bg", 4.5],
  ["--color-danger", "--color-bg", 4.5],
  ["--color-danger", "--color-surface", 4.5],
  ["--color-warning", "--color-bg", 4.5],
  ["--color-warning", "--color-surface", 4.5],
  ["--color-info", "--color-bg", 4.5],
  ["--color-success", "--color-bg", 4.5],
  ["--color-focus", "--color-bg", 3],
  ["--color-focus", "--color-surface", 3],
  ["--color-border", "--color-bg", 1.3],
];

describe("テーマの対比", () => {
  for (const [name, set] of [
    ["ライト", lightTokens],
    ["ダーク", darkTokens],
  ] as const) {
    it(`${name}: 主な組み合わせの対比が WCAG AA 以上`, () => {
      for (const [fg, bg, min] of PAIRS) {
        const a = set[fg];
        const b = set[bg];
        expect(a, fg).toMatch(/^#[0-9a-f]{6}$/i);
        expect(b, bg).toMatch(/^#[0-9a-f]{6}$/i);
        expect(
          contrast(a as string, b as string),
          `${fg} on ${bg}`,
        ).toBeGreaterThanOrEqual(min);
      }
    });
  }

  it("OS 連動の既定（media query）と、data-theme=dark の値が一致する", () => {
    expect(Object.keys(darkMediaTokens).length).toBeGreaterThan(0);
    const colors = (t: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(t).filter(([, v]) => v.startsWith("#")),
      );
    expect(colors(darkMediaTokens)).toEqual(colors(darkTokens));
  });

  it("トークンの一覧が、ライトとダークで一致する", () => {
    expect(Object.keys(lightTokens).sort()).toEqual(
      Object.keys(darkTokens).sort(),
    );
    expect(Object.keys(lightTokens).length).toBeGreaterThanOrEqual(15);
  });
});
