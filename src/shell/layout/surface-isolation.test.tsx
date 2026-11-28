// @vitest-environment happy-dom
// 画面を偽る拡張機能（大きさ・重なりを偽る）が、本体の画面（確認ダイアログ・通知・ステータスバー）を覆えないこと（US2-7）。
// 実機の枠の検査は quickstart.md の 3。ここでは、枠の入れ物の規則と、枠の属性を固定する。
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFrameManager } from "../../host/frames";

const css = readFileSync("src/shell/shell.css", "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? "";
}

const zIndex = (selector: string): number | null => {
  const m = /z-index:\s*(\d+)/.exec(rule(selector));
  return m === null ? null : Number(m[1]);
};

describe("画面の枠は、本体の画面を覆えない（FR-009・US2-7）", () => {
  it("入れ物は、枠の中身を切り取り（overflow・contain: paint）、重なりの順位を持ち込ませない", () => {
    const r = rule(".surface-frame");
    expect(r).toMatch(/overflow:\s*hidden/);
    expect(r).toMatch(/contain:[^;]*paint/);
    expect(r).toMatch(/isolation:\s*isolate/);
    // 入れ物も枠も、z-index・固定配置を持たない（本体の重なりの上へ出さない）
    expect(r).not.toMatch(/z-index|position:\s*(fixed|absolute)/);
    const frame = rule(".surface-frame > iframe");
    expect(frame).not.toMatch(/z-index|position:\s*(fixed|absolute|sticky)/);
    expect(frame).not.toMatch(/transform|margin:\s*-/);
  });

  it("確認ダイアログ・通知・ステータスバーなど本体の重ねる部品は、入れ物より上にある", () => {
    // 入れ物は z-index が無い（auto）ので、z-index を持つ本体の部品が、必ず上に出る。
    expect(zIndex(".surface-frame")).toBeNull();
    expect(zIndex(".overlay")).toBeGreaterThanOrEqual(100);
    const tops = [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(tops.length).toBeGreaterThan(0);
    for (const value of tops) expect(value).toBeGreaterThan(0);
  });

  it("本体が作る枠は、sandbox=allow-scripts だけ。ナビゲーション・ポップアップ・フォーム・ダイアログ・同一オリジンを許さない", () => {
    const manager = createFrameManager({
      doc: document,
      base: "unno://localhost",
      handle: vi.fn(async () => null),
      deliverInit: () => {},
    });
    const host = document.createElement("div");
    document.body.append(host);
    const frame = manager.create({
      extensionId: "x.ext",
      role: "view",
      container: host,
      init: {
        ext: { id: "x.ext", version: "0.0.1", path: "" },
        url: "unno://localhost/ext/x.ext/v.js",
        locale: "ja",
        messages: {},
        theme: {},
        mirror: {},
        ctx: {},
      },
    });
    const sandbox = frame.element.getAttribute("sandbox") ?? "";
    expect(sandbox.split(/\s+/)).toEqual(["allow-scripts"]);
    for (const flag of [
      "allow-same-origin",
      "allow-top-navigation",
      "allow-popups",
      "allow-forms",
      "allow-modals",
      "allow-downloads",
    ])
      expect(sandbox).not.toContain(flag);
    // 本体は、枠に style 属性で位置・大きさ・重なりを足さない（見た目は CSS の規則だけ）
    expect(frame.element.getAttribute("style")).toBeNull();
    manager.remove(frame);
  });
});
