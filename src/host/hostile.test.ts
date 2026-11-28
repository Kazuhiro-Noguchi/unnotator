// @vitest-environment happy-dom
// 敵対的な枠のテスト（T048・T050）。本物の `MessageChannel` で、枠の側から悪意のあるメッセージを送る。
// WebView が要るもの（Tauri の IPC が届かないこと・ナビゲーション・ポップアップ）は quickstart.md 4 の実機の手順。
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_LIMITS, inspectEnvelope } from "./channel";
import { createFrameManager, type Frame, HOST_METHODS } from "./frames";

const settle = () => new Promise((r) => setTimeout(r, 20));

function setup(ids: string[] = ["dev.spike.bad"]) {
  const handle = vi.fn(
    async (_: { extId: string; m: string; a: unknown }) => null,
  );
  const ports = new Map<string, MessagePort>();
  const manager = createFrameManager({
    doc: document,
    base: "unno://localhost",
    handle,
    deliverInit: (el, init, port) => {
      const id = (init as { ext: { id: string } }).ext.id;
      ports.set(`${id}:${el.getAttribute("src")}`, port);
      ports.set(id, port);
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const frames = new Map<string, Frame>();
  for (const id of ids) {
    const frame = manager.create({
      extensionId: id,
      role: "background",
      container,
      init: {
        ext: { id, version: "0.0.1", path: "" },
        url: `unno://localhost/ext/${id}/dist/index.js`,
        locale: "en",
        messages: {},
        theme: {},
        mirror: {},
        ctx: {},
      },
    });
    frame.element.dispatchEvent(new Event("load"));
    frames.set(id, frame);
  }
  return { manager, handle, ports, frames, container };
}

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

describe("敵対的な枠: メッセージ", () => {
  it("巨大なメッセージは拒否され、ハンドラに届かず、失敗に数えられる", async () => {
    const t = setup();
    closers.push(() => t.manager.removeAll("dev.spike.bad"));
    t.ports.get("dev.spike.bad")?.postMessage({
      t: "req",
      id: 1,
      m: "selection.get",
      a: "x".repeat(2 * 1024 * 1024),
    });
    await settle();
    expect(t.handle).not.toHaveBeenCalled();
    expect(t.frames.get("dev.spike.bad")?.stats.failures).toBe(1);
  });

  it("大量のメッセージは、毎秒の上限を超えた分が拒否される", async () => {
    const t = setup();
    closers.push(() => t.manager.removeAll("dev.spike.bad"));
    const port = t.ports.get("dev.spike.bad");
    for (let i = 0; i < CHANNEL_LIMITS.maxPerSecond + 300; i++) {
      port?.postMessage({ t: "req", id: i, m: "selection.get", a: null });
    }
    await settle();
    await settle();
    expect(t.handle.mock.calls.length).toBeLessThanOrEqual(
      CHANNEL_LIMITS.maxPerSecond,
    );
    expect(
      t.frames.get("dev.spike.bad")?.stats.failures,
    ).toBeGreaterThanOrEqual(300);
  });

  it.each([
    [
      "表に無い m（内部呼び出し）",
      { t: "req", id: 1, m: "plugin:event|emit", a: {} },
    ],
    ["本体向けの種別 call", { t: "call", id: 1, m: "invoke", a: {} }],
    ["本体向けの種別 ev", { t: "ev", k: "selection", v: [] }],
    ["形の違うもの", { hello: "world" }],
    ["配列", [1, 2, 3]],
    ["入れ子が深すぎる", { t: "req", id: 1, m: "selection.get", a: nest(40) }],
  ])("%s は、ハンドラに届かない", async (_name, message) => {
    const t = setup();
    closers.push(() => t.manager.removeAll("dev.spike.bad"));
    t.ports.get("dev.spike.bad")?.postMessage(message);
    await settle();
    expect(t.handle).not.toHaveBeenCalled();
  });

  it("他の ID の名乗りは無視され、送り主は枠の経路で決まる", async () => {
    const t = setup();
    closers.push(() => t.manager.removeAll("dev.spike.bad"));
    t.ports.get("dev.spike.bad")?.postMessage({
      t: "req",
      id: 1,
      m: "selection.get",
      a: null,
      ext: "dev.spike.base",
      extId: "dev.spike.base",
      source: "manual",
    });
    await settle();
    expect(t.handle).toHaveBeenCalledTimes(1);
    expect(t.handle.mock.calls[0]?.[0]).toEqual({
      extId: "dev.spike.bad",
      m: "selection.get",
      a: null,
    });
  });

  it("関数を含む値は、構造化複製できず送れない（枠の側の例外）", () => {
    const t = setup();
    closers.push(() => t.manager.removeAll("dev.spike.bad"));
    expect(() =>
      t.ports.get("dev.spike.bad")?.postMessage({
        t: "req",
        id: 1,
        m: "selection.get",
        a: { f: () => 1 },
      }),
    ).toThrow();
  });

  it("最大の大きさのメッセージの検査は、50 ms を超えない（SC-009）", () => {
    const worst = {
      t: "req",
      id: 1,
      m: "selection.get",
      a: Array.from({ length: CHANNEL_LIMITS.maxArrayLength }, () =>
        "x".repeat(90),
      ),
    };
    const started = performance.now();
    inspectEnvelope(worst, { methods: HOST_METHODS });
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("敵対的な枠: 属性", () => {
  it("sandbox は allow-scripts だけで、枠は @host の起動用ページを指す", () => {
    const t = setup();
    closers.push(() => t.manager.removeAll("dev.spike.bad"));
    const el = t.frames.get("dev.spike.bad")?.element;
    expect(el?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(el?.getAttribute("src")).toBe(
      "unno://localhost/ext/dev.spike.bad/@host/frame.html?role=background",
    );
  });

  it("allow-forms・allow-popups・allow-top-navigation・allow-downloads・allow-modals は付かない", () => {
    const t = setup();
    closers.push(() => t.manager.removeAll("dev.spike.bad"));
    const sandbox =
      t.frames.get("dev.spike.bad")?.element.getAttribute("sandbox") ?? "";
    for (const flag of [
      "allow-forms",
      "allow-popups",
      "allow-top-navigation",
      "allow-downloads",
      "allow-modals",
      "allow-same-origin",
      "allow-popups-to-escape-sandbox",
    ]) {
      expect(sandbox).not.toContain(flag);
    }
  });
});

describe("枠どうしの独立（T050）", () => {
  it("A の枠からの呼び出しの送り主は A、B の枠からは B になる", async () => {
    const t = setup(["dev.spike.a", "dev.spike.b"]);
    closers.push(() => {
      t.manager.removeAll("dev.spike.a");
      t.manager.removeAll("dev.spike.b");
    });
    t.ports
      .get("dev.spike.a")
      ?.postMessage({ t: "req", id: 1, m: "selection.get", a: null });
    t.ports
      .get("dev.spike.b")
      ?.postMessage({ t: "req", id: 1, m: "selection.get", a: null });
    await settle();
    const senders = t.handle.mock.calls.map((c) => c[0].extId).sort();
    expect(senders).toEqual(["dev.spike.a", "dev.spike.b"]);
  });

  it("A の枠の port では、B の枠に応答や通知が届かない", async () => {
    const t = setup(["dev.spike.a", "dev.spike.b"]);
    closers.push(() => {
      t.manager.removeAll("dev.spike.a");
      t.manager.removeAll("dev.spike.b");
    });
    const seenByB: unknown[] = [];
    const portB = t.ports.get("dev.spike.b");
    if (portB) portB.onmessage = (e) => seenByB.push(e.data);
    t.frames.get("dev.spike.a")?.channel.emit("selection", ["x"]);
    await settle();
    expect(seenByB).toEqual([]);
  });

  it("A の枠を取り除いても、B の枠は生きている", async () => {
    const t = setup(["dev.spike.a", "dev.spike.b"]);
    closers.push(() => t.manager.removeAll("dev.spike.b"));
    const a = t.frames.get("dev.spike.a");
    if (a) t.manager.remove(a);
    expect(t.manager.framesOf("dev.spike.b")).toHaveLength(1);
  });

  it("同じ拡張機能の裏の枠と画面の枠は、別の枠（別の port・別の iframe）", () => {
    const t = setup(["dev.spike.a"]);
    const bg = t.frames.get("dev.spike.a");
    const view = t.manager.create({
      extensionId: "dev.spike.a",
      role: "view",
      container: t.container,
      init: {
        ext: { id: "dev.spike.a", version: "0.0.1", path: "" },
        url: "unno://localhost/ext/dev.spike.a/dist/surface.js",
        locale: "en",
        messages: {},
        theme: {},
        mirror: {},
        ctx: {},
      },
    });
    closers.push(() => t.manager.removeAll("dev.spike.a"));
    expect(view).not.toBe(bg);
    expect(view.element).not.toBe(bg?.element);
    expect(view.channel).not.toBe(bg?.channel);
  });
});

function nest(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = { v };
  return v;
}
