// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { PortLike } from "./channel";
import { createFrameManager, frameSrc } from "./frames";

function setup() {
  const delivered: { init: unknown; port: unknown }[] = [];
  const manager = createFrameManager({
    doc: document,
    base: "unno://localhost",
    handle: vi.fn(async () => null),
    deliverInit: (_el, init, port) => delivered.push({ init, port }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const baseInit = {
    ext: { id: "com.example.a", version: "0.1.0", path: "" },
    url: "unno://localhost/ext/com.example.a/dist/index.js",
    locale: "ja",
    messages: {},
    theme: {},
    mirror: {},
    ctx: {},
  };
  return { manager, host, delivered, baseInit };
}

describe("frameSrc", () => {
  it("予約パス @host の frame.html を指し、role をつける", () => {
    expect(frameSrc("unno://localhost", "com.example.a", "view")).toBe(
      "unno://localhost/ext/com.example.a/@host/frame.html?role=view",
    );
    expect(
      frameSrc("http://unno.localhost", "com.example.a", "background"),
    ).toBe(
      "http://unno.localhost/ext/com.example.a/@host/frame.html?role=background",
    );
  });
});

describe("createFrameManager", () => {
  it("sandbox は allow-scripts だけで、allow-same-origin は付かない", () => {
    const { manager, host, baseInit } = setup();
    const frame = manager.create({
      extensionId: "com.example.a",
      role: "view",
      container: host,
      init: baseInit,
    });
    const sandbox = frame.element.getAttribute("sandbox");
    expect(sandbox).toBe("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(frame.element.getAttribute("src")).toContain(
      "/@host/frame.html?role=view",
    );
    expect(host.contains(frame.element)).toBe(true);
  });

  it("読み込みが終わると init を port つきで渡す", () => {
    const { manager, host, delivered, baseInit } = setup();
    const frame = manager.create({
      extensionId: "com.example.a",
      role: "view",
      container: host,
      init: baseInit,
    });
    expect(delivered).toHaveLength(0);
    frame.element.dispatchEvent(new Event("load"));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.init).toMatchObject({
      t: "init",
      role: "view",
      base: "unno://localhost",
    });
    // 2 回目の load（再読み込み）では、渡さない。
    frame.element.dispatchEvent(new Event("load"));
    expect(delivered).toHaveLength(1);
  });

  it("同じ拡張機能の裏の枠は 1 つ", () => {
    const { manager, host, baseInit } = setup();
    const a = manager.create({
      extensionId: "com.example.a",
      role: "background",
      container: host,
      init: baseInit,
    });
    const b = manager.create({
      extensionId: "com.example.a",
      role: "background",
      container: host,
      init: baseInit,
    });
    expect(b).toBe(a);
    expect(host.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("画面の枠は、開くたびに別になる", () => {
    const { manager, host, baseInit } = setup();
    const a = manager.create({
      extensionId: "com.example.a",
      role: "view",
      container: host,
      init: baseInit,
    });
    const b = manager.create({
      extensionId: "com.example.a",
      role: "view",
      container: host,
      init: baseInit,
    });
    expect(b).not.toBe(a);
    expect(manager.framesOf("com.example.a")).toHaveLength(2);
  });

  it("取り除くと、要素・port・保留中の呼び出しが消える", async () => {
    const { manager, host, baseInit } = setup();
    const frame = manager.create({
      extensionId: "com.example.a",
      role: "background",
      container: host,
      init: baseInit,
    });
    const pending = frame.channel.call("x", null);
    const assertion = expect(pending).rejects.toMatchObject({ code: "Closed" });
    manager.remove(frame);
    await assertion;
    expect(host.querySelectorAll("iframe")).toHaveLength(0);
    expect(frame.channel.pendingCount).toBe(0);
    expect(manager.framesOf("com.example.a")).toHaveLength(0);
    // 取り除いたあとは、同じ拡張機能の裏の枠を作り直せる。
    const again = manager.create({
      extensionId: "com.example.a",
      role: "background",
      container: host,
      init: baseInit,
    });
    expect(again).not.toBe(frame);
  });

  it("拡張機能の枠をまとめて取り除ける", () => {
    const { manager, host, baseInit } = setup();
    manager.create({
      extensionId: "com.example.a",
      role: "background",
      container: host,
      init: baseInit,
    });
    manager.create({
      extensionId: "com.example.a",
      role: "view",
      container: host,
      init: baseInit,
    });
    manager.removeAll("com.example.a");
    expect(host.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("枠の統計: 失敗の数と呼び出し回数が数えられる", async () => {
    const { manager, host, baseInit } = setup();
    const frame = manager.create({
      extensionId: "com.example.a",
      role: "view",
      container: host,
      init: baseInit,
    });
    const port = frame.channel as unknown as { receive(d: unknown): void };
    port.receive({ t: "req", id: 1, m: "nope.nope", a: null });
    expect(frame.stats.failures).toBe(1);
  });
});

// 型の確認: PortLike を満たす。
const _check: PortLike | null = null;
void _check;

describe("createFrameManager: 枠ごとの受け口", () => {
  it("取り除かれると onRemoved が 1 回だけ呼ばれる", () => {
    const { manager, host, baseInit } = setup();
    const onRemoved = vi.fn();
    const frame = manager.create({
      extensionId: "com.example.a",
      role: "editor",
      container: host,
      init: baseInit,
      onRemoved,
    });
    manager.remove(frame);
    manager.removeAll("com.example.a");
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });
});
