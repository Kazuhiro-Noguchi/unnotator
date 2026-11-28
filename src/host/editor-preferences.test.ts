import { describe, expect, it, vi } from "vitest";
import { createProjectPreferences } from "./editor-preferences";

function setup(initial: Record<string, string> = {}) {
  let stored = { ...initial };
  const port = {
    read: vi.fn(async () => ({ ...stored })),
    write: vi.fn(async (map: Record<string, string>) => {
      stored = { ...map };
    }),
  };
  return { port, prefs: createProjectPreferences(port), stored: () => stored };
}

describe("既定のエディターの保存（core.editors.default）", () => {
  it("読み込むまでは空。load でプロジェクト設定の値が見える", async () => {
    const t = setup({ "a.b/text": "a.b/editor" });
    expect(t.prefs.get("a.b/text")).toBeUndefined();
    await t.prefs.load();
    expect(t.prefs.get("a.b/text")).toBe("a.b/editor");
  });

  it("set は、すぐ読め、プロジェクト設定へ書く（ほかの媒体種別の値を消さない）", async () => {
    const t = setup({ "a.b/text": "a.b/editor" });
    await t.prefs.load();
    t.prefs.set("a.b/image", "a.b/viewer");
    expect(t.prefs.get("a.b/image")).toBe("a.b/viewer");
    await vi.waitFor(() => expect(t.port.write).toHaveBeenCalledTimes(1));
    expect(t.stored()).toEqual({
      "a.b/text": "a.b/editor",
      "a.b/image": "a.b/viewer",
    });
  });

  it("読めない・形が違う値は、空として扱う", async () => {
    const t = setup();
    t.port.read.mockResolvedValueOnce({ x: 1 } as never);
    await t.prefs.load();
    expect(t.prefs.get("x")).toBeUndefined();
    t.port.read.mockRejectedValueOnce(new Error("no project"));
    await expect(t.prefs.load()).resolves.toBeUndefined();
  });

  it("clear（プロジェクトを閉じる）で、写しが空になる", async () => {
    const t = setup({ "a/t": "a/e" });
    await t.prefs.load();
    t.prefs.clear();
    expect(t.prefs.get("a/t")).toBeUndefined();
  });

  it("書き込みの失敗は、onError に知らせる（黙って失わない）", async () => {
    const onError = vi.fn();
    const port = {
      read: async () => ({}),
      write: vi.fn(async () => {
        throw new Error("readonly");
      }),
    };
    const prefs = createProjectPreferences(port, onError);
    prefs.set("a/t", "a/e");
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    // 画面の上は、このセッションの間は選んだものを使う。
    expect(prefs.get("a/t")).toBe("a/e");
  });
});
