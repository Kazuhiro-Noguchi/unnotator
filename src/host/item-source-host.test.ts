import { describe, expect, it, vi } from "vitest";
import { ChannelError } from "./channel";
import { ItemSourceError } from "./item-source";
import { createItemLister, type ItemListerDeps } from "./item-source-host";

const range = { offset: 0, limit: 10 };

function setup(
  call: (m: string, a: unknown) => Promise<unknown>,
  overrides: Partial<ItemListerDeps> = {},
) {
  const background = vi.fn(async () => ({ call }));
  const lister = createItemLister({
    target: async () => ({ asset: { id: "a1" }, provider: "x.ext/pages" }),
    background,
    ...overrides,
  });
  return { lister, background };
}

describe("createItemLister（拡張機能の ItemProvider を裏の枠へ呼ぶ）", () => {
  it("提供元の拡張機能の裏の枠へ invoke で list を呼び、結果を返す", async () => {
    const call = vi.fn(async () => ({
      items: [{ key: "page:1", title: "P1" }],
      total: 3,
    }));
    const { lister, background } = setup(call);
    const page = await lister("a1", range, new AbortController().signal);
    expect(background).toHaveBeenCalledWith("x.ext");
    expect(call).toHaveBeenCalledWith(
      "invoke",
      expect.objectContaining({
        kind: "items",
        localId: "pages",
        member: "list",
        args: [{ id: "a1" }, range],
        withSignal: expect.any(String),
      }),
    );
    expect(page).toEqual({ items: [{ key: "page:1", title: "P1" }], total: 3 });
  });

  it("アセットが無い・提供元が無い・枠が無いときは、未対応か失敗", async () => {
    const call = vi.fn();
    const s1 = setup(call, { target: async () => null });
    await expect(
      s1.lister("a1", range, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "unsupported" });
    const s2 = setup(call, { background: async () => undefined });
    await expect(
      s2.lister("a1", range, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "failed" });
    expect(call).not.toHaveBeenCalled();
  });

  it("応答が遅いときは timeout、それ以外の失敗は failed", async () => {
    const slow = setup(async () => {
      throw new ChannelError("Timeout", "slow");
    });
    await expect(
      slow.lister("a1", range, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "timeout" });
    const bad = setup(async () => {
      throw new Error("boom");
    });
    await expect(
      bad.lister("a1", range, new AbortController().signal),
    ).rejects.toBeInstanceOf(ItemSourceError);
  });

  it("形の合わない応答は failed", async () => {
    for (const value of [null, { items: "x" }, { items: [{ title: "t" }] }]) {
      const { lister } = setup(async () => value);
      await expect(
        lister("a1", range, new AbortController().signal),
      ).rejects.toMatchObject({ kind: "failed" });
    }
  });

  it("中断すると AbortError で返り、枠へ中断を伝える", async () => {
    const calls: Array<[string, unknown]> = [];
    const { lister } = setup((m, a) => {
      calls.push([m, a]);
      return m === "invoke" ? new Promise(() => {}) : Promise.resolve(null);
    });
    const controller = new AbortController();
    const promise = lister("a1", range, controller.signal);
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    const invoke = calls.find(([m]) => m === "invoke")?.[1] as {
      withSignal: string;
    };
    expect(calls).toContainEqual(["abort", { token: invoke.withSignal }]);
  });
});
