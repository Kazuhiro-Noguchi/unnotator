// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createFrameManager } from "./frames";

function setup() {
  const onCreate = vi.fn();
  const onRemove = vi.fn();
  const manager = createFrameManager({
    doc: document,
    base: "unno://localhost",
    handle: vi.fn(async () => null),
    deliverInit: () => {},
    onCreate,
    onRemove,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const init = {
    ext: { id: "com.example.a", version: "0.1.0", path: "" },
    url: "unno://localhost/ext/com.example.a/main.js",
    locale: "ja",
    messages: {},
    theme: {},
    mirror: {},
    ctx: {},
  };
  return { manager, container, init, onCreate, onRemove };
}

describe("枠の生成と取り除きの通知", () => {
  it("枠を作ると onCreate、取り除くと onRemove が呼ばれる", () => {
    const { manager, container, init, onCreate, onRemove } = setup();
    const frame = manager.create({
      extensionId: "com.example.a",
      role: "view",
      container,
      init,
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith(frame);
    manager.remove(frame);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith(frame);
  });

  it("裏の枠を二重に作っても、onCreate は 1 回（既存の枠を返す）", () => {
    const { manager, container, init, onCreate } = setup();
    const a = manager.create({
      extensionId: "com.example.a",
      role: "background",
      container,
      init,
    });
    const b = manager.create({
      extensionId: "com.example.a",
      role: "background",
      container,
      init,
    });
    expect(a).toBe(b);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("removeAll は、すべての枠の onRemove を呼ぶ", () => {
    const { manager, container, init, onRemove } = setup();
    for (const role of ["view", "editor"] as const)
      manager.create({ extensionId: "com.example.a", role, container, init });
    manager.removeAll("com.example.a");
    expect(onRemove).toHaveBeenCalledTimes(2);
  });

  it("onCreate・onRemove が例外を投げても、枠の操作は続く", () => {
    const { container, init } = setup();
    const manager = createFrameManager({
      doc: document,
      base: "unno://localhost",
      handle: vi.fn(async () => null),
      deliverInit: () => {},
      onCreate: () => {
        throw new Error("x");
      },
      onRemove: () => {
        throw new Error("y");
      },
    });
    const frame = manager.create({
      extensionId: "com.example.a",
      role: "view",
      container,
      init,
    });
    expect(() => manager.remove(frame)).not.toThrow();
    expect(manager.framesOf("com.example.a")).toHaveLength(0);
  });
});
