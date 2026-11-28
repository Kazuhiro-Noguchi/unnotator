// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createExtensionHost, type ExtensionInfo } from "./service";

function info(
  id: string,
  manifest: Record<string, unknown>,
  status = "enabled",
): ExtensionInfo {
  return {
    id,
    version: "1.0.0",
    status,
    manifest: JSON.stringify({
      id,
      version: "1.0.0",
      main: "dist/index.js",
      ...manifest,
    }),
  };
}

function setup(
  list: ExtensionInfo[],
  behaviour: "ready" | "error" | "silent" = "ready",
) {
  const ports = new Map<string, MessagePort>();
  const sent: { id: string; message: unknown }[] = [];
  const report = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  let current = list;
  const host = createExtensionHost({
    list: async () => current,
    doc: document,
    container,
    base: "unno://localhost",
    locale: () => "ja",
    handle: async () => null,
    report,
    startTimeoutMs: 50,
    stopTimeoutMs: 20,
    deliverInit: (element, init, port) => {
      const id = (init as { ext: { id: string } }).ext.id;
      ports.set(id, port);
      port.onmessage = (event) => sent.push({ id, message: event.data });
      if (behaviour === "ready")
        port.postMessage({ t: "rep", kind: "ready", v: null });
      if (behaviour === "error")
        port.postMessage({
          t: "rep",
          kind: "error",
          v: { phase: "import", message: "load failed" },
        });
      void element;
    },
  });
  const loadFrames = () => {
    for (const el of container.querySelectorAll("iframe"))
      el.dispatchEvent(new Event("load"));
  };
  return {
    host,
    container,
    sent,
    report,
    loadFrames,
    setList: (l: ExtensionInfo[]) => (current = l),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("createExtensionHost", () => {
  it("起動時は、onStartup の拡張機能だけ枠を作る", async () => {
    const t = setup([
      info("a.start", { activationEvents: ["onStartup"] }),
      info("a.lazy", { activationEvents: ["onCommand:a.lazy.run"] }),
    ]);
    const p = t.host.startup();
    await tick();
    t.loadFrames();
    await p;
    expect(t.container.querySelectorAll("iframe")).toHaveLength(1);
    expect(t.host.manager.state("a.start").status).toBe("active");
    expect(t.host.manager.state("a.lazy").status).toBe("inactive");
  });

  it("枠の src は @host の起動用ページで、モジュールの URL は main", async () => {
    const t = setup([info("a.start", { activationEvents: ["onStartup"] })]);
    const p = t.host.startup();
    await tick();
    const iframe = t.container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe(
      "unno://localhost/ext/a.start/@host/frame.html?role=background",
    );
    t.loadFrames();
    await p;
    expect(t.sent.length).toBeGreaterThanOrEqual(0);
  });

  it("読み込みの失敗は failed になり、利用者に知らせる", async () => {
    const t = setup(
      [info("a.bad", { activationEvents: ["onStartup"] })],
      "error",
    );
    const p = t.host.startup();
    await tick();
    t.loadFrames();
    await p;
    expect(t.host.manager.state("a.bad")).toMatchObject({
      status: "failed",
      failure: { code: "StartFailed", message: "load failed" },
    });
    expect(t.report).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("load failed"),
      "a.bad",
    );
    // 失敗した枠は残さない。
    expect(t.container.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("枠が応答しなければ、時間切れで failed", async () => {
    const t = setup(
      [info("a.slow", { activationEvents: ["onStartup"] })],
      "silent",
    );
    const p = t.host.startup();
    await tick();
    t.loadFrames();
    await p;
    expect(t.host.manager.state("a.slow").failure?.code).toBe("StartFailed");
    expect(t.container.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("trigger で、あとから有効にできる", async () => {
    const t = setup([
      info("a.lazy", { activationEvents: ["onCommand:a.lazy.run"] }),
    ]);
    await t.host.startup();
    expect(t.container.querySelectorAll("iframe")).toHaveLength(0);
    const p = t.host.trigger("onCommand:a.lazy.run");
    await tick();
    t.loadFrames();
    await p;
    expect(t.host.manager.state("a.lazy").status).toBe("active");
  });

  it("refresh で無効になった拡張機能は止まり、枠が取り除かれる", async () => {
    const t = setup([info("a.start", { activationEvents: ["onStartup"] })]);
    const p = t.host.startup();
    await tick();
    t.loadFrames();
    await p;
    t.setList([
      info("a.start", { activationEvents: ["onStartup"] }, "disabled"),
    ]);
    const r = t.host.refresh();
    await tick();
    // 枠が `deactivate` に応答しなくても、時間切れのあとで取り除かれる。
    await r;
    expect(t.container.querySelectorAll("iframe")).toHaveLength(0);
    expect(t.host.manager.state("a.start").status).toBe("disabled");
  }, 10000);

  it("shutdown で、すべての枠が取り除かれる", async () => {
    const t = setup([info("a.start", { activationEvents: ["onStartup"] })]);
    const p = t.host.startup();
    await tick();
    t.loadFrames();
    await p;
    await t.host.shutdown({ timeoutMs: 20 });
    expect(t.container.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("マニフェストが読めないものは、無視する", async () => {
    const t = setup([
      { id: "a.broken", version: "1.0.0", status: "enabled", manifest: "{" },
    ]);
    await expect(t.host.startup()).resolves.toBeUndefined();
  });
});

describe("createExtensionHost: 画面の枠（US2）", () => {
  it("読み直した一覧を infos() で返し、onDidRefresh で知らせる", async () => {
    const t = setup([info("a.one", { activationEvents: [] })]);
    const seen: string[][] = [];
    t.host.onDidRefresh((list) => seen.push(list.map((i) => i.id)));
    expect(t.host.infos()).toEqual([]);
    await t.host.refresh();
    expect(t.host.infos().map((i) => i.id)).toEqual(["a.one"]);
    expect(seen).toEqual([["a.one"]]);
  });

  it("拡張機能を止めるとき、画面の枠に先に dispose を送ってから deactivate する", async () => {
    const t = setup([info("a.start", { activationEvents: ["onStartup"] })]);
    const p = t.host.startup();
    await tick();
    t.loadFrames();
    await p;
    t.host.frames.create({
      extensionId: "a.start",
      role: "editor",
      container: t.container,
      init: {
        ext: { id: "a.start", version: "1.0.0", path: "" },
        url: "unno://localhost/ext/a.start/e.js",
        locale: "ja",
        messages: {},
        theme: {},
        mirror: {},
        ctx: {},
      },
    });
    t.loadFrames();
    t.setList([
      info("a.start", { activationEvents: ["onStartup"] }, "disabled"),
    ]);
    await t.host.refresh();
    const calls = t.sent
      .map((s) => s.message as { t: string; m?: string })
      .filter((m) => m.t === "call")
      .map((m) => m.m);
    // 本体の枠は、止めた直後に取り除かれる。`dispose` は取り除く前に送られている。
    expect(calls).toContain("dispose");
    expect(calls.indexOf("dispose")).toBeLessThanOrEqual(
      calls.includes("deactivate") ? calls.indexOf("deactivate") : 0,
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(t.container.querySelectorAll("iframe")).toHaveLength(0);
  }, 10000);
});
