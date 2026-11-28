// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Frame, FrameManager } from "./frames";
import { createFrameManager } from "./frames";
import {
  createSurfaceOpener,
  readThemeVariables,
  type SurfaceState,
  THEME_VARIABLE_NAMES,
} from "./placement-frame";

function setup(options: { readyTimeoutMs?: number } = {}) {
  const delivered: Array<{ init: Record<string, unknown> }> = [];
  const frames = createFrameManager({
    doc: document,
    base: "unno://localhost",
    handle: vi.fn(async () => null),
    deliverInit: (_el, init) =>
      delivered.push({ init: init as Record<string, unknown> }),
  });
  let themeListener: (() => void) | null = null;
  let theme: Record<string, string> = { "--color-bg": "#fff" };
  const opener = createSurfaceOpener({
    frames,
    base: "unno://localhost",
    locale: () => "ja",
    versionOf: () => "0.0.1",
    themeVariables: () => theme,
    observeTheme: (listener) => {
      themeListener = listener;
      return () => {
        themeListener = null;
      };
    },
    ...options,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const states: SurfaceState[] = [];
  const open = (patch: Record<string, unknown> = {}) =>
    opener.open({
      extensionId: "x.ext",
      surfaceId: "x.ext/main",
      role: "editor",
      entry: "dist/editor.js",
      ctx: { asset: { id: "a1" } },
      container,
      onState: (s) => states.push(s),
      ...patch,
    });
  const frameOf = (): Frame => frames.framesOf("x.ext")[0] as Frame;
  return {
    frames: frames as FrameManager,
    open,
    container,
    states,
    delivered,
    frameOf,
    setTheme(next: Record<string, string>) {
      theme = next;
      themeListener?.();
    },
    hasThemeListener: () => themeListener !== null,
  };
}

const report = (frame: Frame, kind: "error" | "log" | "ready", v: unknown) =>
  (
    frame as unknown as {
      // テスト用: 枠からの報告を、本体側の経路の入り口に直接入れる。
      channel: { options: { onReport: (k: string, v: unknown) => void } };
    }
  ).channel.options.onReport(kind, v);

describe("createSurfaceOpener", () => {
  it("画面の枠（role・entry の URL・asset の文脈・テーマ）を、入れ物の中に作る", () => {
    const s = setup();
    s.open();
    const frame = s.frameOf();
    expect(frame.role).toBe("editor");
    expect(s.container.contains(frame.element)).toBe(true);
    // load で init が渡る
    frame.element.dispatchEvent(new Event("load"));
    expect(s.delivered[0]?.init).toMatchObject({
      t: "init",
      role: "editor",
      url: "unno://localhost/ext/x.ext/dist/editor.js",
      ctx: { asset: { id: "a1" } },
      theme: { "--color-bg": "#fff" },
      locale: "ja",
      ext: { id: "x.ext", version: "0.0.1" },
    });
  });

  it("entry の先頭のスラッシュや ../ を含む値でも、拡張機能のフォルダの外を指さない", () => {
    const s = setup();
    s.open({ entry: "/../../other.ext/x.js" });
    s.frameOf().element.dispatchEvent(new Event("load"));
    const sent = s.delivered[0]?.init.url as string;
    expect(sent.startsWith("unno://localhost/ext/x.ext/")).toBe(true);
    expect(sent).not.toContain("..");
  });

  it("枠が ready を報告したら ready、準備の前の error は failed", () => {
    const s = setup();
    s.open();
    report(s.frameOf(), "ready", null);
    expect(s.states).toEqual([{ kind: "ready" }]);
    const s2 = setup();
    s2.open();
    report(s2.frameOf(), "error", { message: "bad import" });
    expect(s2.states).toEqual([{ kind: "failed", message: "bad import" }]);
  });

  it("準備の後の error では、失敗にしない（枠は動き続ける）", () => {
    const s = setup();
    s.open();
    report(s.frameOf(), "ready", null);
    report(s.frameOf(), "error", { message: "late" });
    expect(s.states).toEqual([{ kind: "ready" }]);
  });

  it("時間内に準備できなければ failed", () => {
    vi.useFakeTimers();
    try {
      const s = setup({ readyTimeoutMs: 1000 });
      s.open();
      vi.advanceTimersByTime(1001);
      expect(s.states[0]).toMatchObject({ kind: "failed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose は、本体から dispose を呼んでから枠を取り除く。通知は出さない", async () => {
    const s = setup();
    const handle = s.open();
    const frame = s.frameOf();
    const call = vi.spyOn(frame.channel, "call").mockResolvedValue(null);
    handle.dispose();
    expect(call).toHaveBeenCalledWith("dispose", null);
    expect(s.container.contains(frame.element)).toBe(false);
    expect(s.frames.framesOf("x.ext")).toHaveLength(0);
    expect(s.states).toEqual([]);
    expect(s.hasThemeListener()).toBe(false);
  });

  it("外から枠が取り除かれたら（拡張機能の無効化）、removed を知らせる", () => {
    const s = setup();
    s.open();
    s.frames.removeAll("x.ext");
    expect(s.states).toEqual([{ kind: "removed" }]);
  });

  it("テーマが切り替わったら、枠へ ev theme を送る", () => {
    const s = setup();
    s.open();
    const emit = vi.spyOn(s.frameOf().channel, "emit");
    s.setTheme({ "--color-bg": "#000" });
    expect(emit).toHaveBeenCalledWith("theme", { "--color-bg": "#000" });
  });

  it("emit は枠へそのまま渡す（表示状態など）", () => {
    const s = setup();
    const handle = s.open();
    const emit = vi.spyOn(s.frameOf().channel, "emit");
    handle.emit("visibility", false);
    expect(emit).toHaveBeenCalledWith("visibility", false);
  });
});

describe("テーマの色の変数", () => {
  it("light.css のトークンをすべて含む（足し忘れを検出する）", () => {
    const css = readFileSync("src/themes/light.css", "utf8");
    const names = [...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect(THEME_VARIABLE_NAMES).toContain(name);
  });

  it("文書の計算済みの値を読む。空の値は含めない", () => {
    document.documentElement.style.setProperty("--color-bg", "#123456");
    const values = readThemeVariables(document);
    expect(values["--color-bg"]).toBe("#123456");
    for (const v of Object.values(values)) expect(v).not.toBe("");
    document.documentElement.removeAttribute("style");
  });
});
