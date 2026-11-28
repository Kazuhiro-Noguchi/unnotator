// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createExtensionHost, type ExtensionInfo } from "./service";

const info: ExtensionInfo = {
  id: "com.example.a",
  version: "1.0.0",
  status: "enabled",
  manifest: JSON.stringify({
    id: "com.example.a",
    version: "1.0.0",
    main: "dist/index.js",
    activationEvents: ["onStartup"],
  }),
};

function setup(extra: Partial<Parameters<typeof createExtensionHost>[0]> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const inits: unknown[] = [];
  const ports: MessagePort[] = [];
  const host = createExtensionHost({
    list: async () => [info],
    doc: document,
    container,
    base: "unno://localhost",
    locale: () => "ja",
    handle: async () => null,
    report: vi.fn(),
    startTimeoutMs: 100,
    stopTimeoutMs: 20,
    deliverInit: (_el, init, port) => {
      inits.push(init);
      ports.push(port);
      port.postMessage({ t: "rep", kind: "ready", v: null });
    },
    ...extra,
  });
  const loadFrames = () => {
    for (const el of container.querySelectorAll("iframe"))
      el.dispatchEvent(new Event("load"));
  };
  return { host, inits, ports, loadFrames };
}

describe("Host API との結び（写し・枠の生成・ログ）", () => {
  it("裏の枠の init の mirror に、mirrorInit の値が入る", async () => {
    const t = setup({
      mirrorInit: async (id) => ({ selection: [id], settings: { k: 1 } }),
    });
    const started = t.host.startup();
    await new Promise((r) => setTimeout(r, 5));
    t.loadFrames();
    await started;
    // 渡されなかったキーは既定の値で埋まる（写しは、init にあるキーだけを更新できる）。
    expect((t.inits[0] as { mirror: unknown }).mirror).toEqual({
      selection: ["com.example.a"],
      "labels.active": null,
      settings: { k: 1 },
      "assets.current": null,
      "tools.active": null,
    });
  });

  it("mirrorInit が無い・失敗したときは、既定の値で始まる（枠は作る）", async () => {
    const t = setup({
      mirrorInit: async () => {
        throw new Error("boom");
      },
    });
    const started = t.host.startup();
    await new Promise((r) => setTimeout(r, 5));
    t.loadFrames();
    await started;
    expect((t.inits[0] as { mirror: Record<string, unknown> }).mirror).toEqual({
      selection: [],
      "labels.active": null,
      settings: {},
      "assets.current": null,
      "tools.active": null,
    });
  });

  it("枠の生成・取り除きが onFrameCreate / onFrameRemove に届く", async () => {
    const created = vi.fn();
    const removed = vi.fn();
    const t = setup({ onFrameCreate: created, onFrameRemove: removed });
    const started = t.host.startup();
    await new Promise((r) => setTimeout(r, 5));
    t.loadFrames();
    await started;
    expect(created).toHaveBeenCalledTimes(1);
    await t.host.shutdown();
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it("枠の log の報告が onLog に、拡張機能 ID つきで届く", async () => {
    const onLog = vi.fn();
    const t = setup({ onLog });
    const started = t.host.startup();
    await new Promise((r) => setTimeout(r, 5));
    t.loadFrames();
    await started;
    t.ports[0]?.postMessage({
      t: "rep",
      kind: "log",
      v: { level: "info", args: ["hello"] },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(onLog).toHaveBeenCalledWith("com.example.a", {
      level: "info",
      args: ["hello"],
    });
  });
});
