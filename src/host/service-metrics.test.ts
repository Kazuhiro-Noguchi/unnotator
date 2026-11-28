// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createExtensionHost } from "./service";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("拡張機能ホストの計測（T067）", () => {
  it("有効化の時間と、枠からの呼び出しの回数・遅い呼び出しの警告を記録する", async () => {
    const record = vi.fn();
    const ports = new Map<string, MessagePort>();
    const container = document.createElement("div");
    document.body.append(container);
    const host = createExtensionHost({
      list: async () => [
        {
          id: "a.b",
          version: "1.0.0",
          status: "enabled",
          manifest: JSON.stringify({
            id: "a.b",
            version: "1.0.0",
            main: "dist/index.js",
            activationEvents: ["onStartup"],
          }),
        },
      ],
      doc: document,
      container,
      base: "unno://localhost",
      locale: () => "ja",
      handle: async () => {
        await tick(60);
        return null;
      },
      report: () => {},
      record,
      pingIntervalMs: 0,
      deliverInit: (_el, init, port) => {
        ports.set((init as { ext: { id: string } }).ext.id, port);
        port.postMessage({ t: "rep", kind: "ready", v: null });
      },
    });
    const p = host.startup();
    await tick();
    for (const el of container.querySelectorAll("iframe"))
      el.dispatchEvent(new Event("load"));
    await p;
    expect(host.metrics.snapshot()["a.b"]?.activationMs).toBeGreaterThanOrEqual(
      0,
    );

    ports
      .get("a.b")
      ?.postMessage({ t: "req", id: 1, m: "selection.get", a: null });
    await tick(120);
    const m = host.metrics.snapshot()["a.b"];
    expect(m?.calls).toBe(1);
    expect(m?.slowCalls).toBe(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ extId: "a.b", kind: "warn" }),
    );
    await host.shutdown({ timeoutMs: 10 });
  });
});
