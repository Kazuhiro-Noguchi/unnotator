import { describe, expect, it } from "vitest";
import {
  createHostItemSource,
  FakeItemSource,
  ItemSourceError,
} from "./item-source";

const signal = new AbortController().signal;

describe("FakeItemSource", () => {
  it("提供元の無い媒体は、既定で asset 単位・アイテム無し", () => {
    const source = new FakeItemSource();
    expect(source.traitsOf(null)).toEqual({
      workUnit: "asset",
      provider: null,
      hasItems: false,
    });
    expect(source.traitsOf("x/y")).toEqual({
      workUnit: "asset",
      provider: null,
      hasItems: false,
    });
  });

  it("宣言した媒体だけが、指定の作業単位とアイテム有りになる", () => {
    const source = new FakeItemSource();
    source.declare("x/doc", {
      workUnit: "item",
      provider: "x/pages",
      hasItems: true,
    });
    expect(source.traitsOf("x/doc")).toEqual({
      workUnit: "item",
      provider: "x/pages",
      hasItems: true,
    });
    expect(source.traitsOf("x/other").hasItems).toBe(false);
    expect(source.itemMediaTypes()).toEqual(["x/doc"]);
  });

  it("範囲を指定して列挙し、total を返す", async () => {
    const source = new FakeItemSource();
    source.setItems("a1", 250);
    const page = await source.list("a1", { offset: 100, limit: 100 }, signal);
    expect(page.total).toBe(250);
    expect(page.items.length).toBe(100);
    expect(page.items[0]?.key).toBe("item:100");
    const tail = await source.list("a1", { offset: 200, limit: 100 }, signal);
    expect(tail.items.length).toBe(50);
  });

  it("記録済みの状態を ItemInfo に載せられる", async () => {
    const source = new FakeItemSource();
    source.setItems("a1", 3, { "item:1": "done" });
    const page = await source.list("a1", { offset: 0, limit: 10 }, signal);
    expect(page.items.map((i) => i.status)).toEqual([
      undefined,
      "done",
      undefined,
    ]);
  });

  it("total を伏せて列挙できる（総数が未定の提供元）", async () => {
    const source = new FakeItemSource();
    source.setItems("a1", 5, {}, { hideTotal: true });
    const page = await source.list("a1", { offset: 0, limit: 10 }, signal);
    expect(page.total).toBeUndefined();
    expect(page.items.length).toBe(5);
  });

  it("失敗・時間切れ・提供元の外れを ItemSourceError で返す", async () => {
    const source = new FakeItemSource();
    source.setItems("a1", 5);
    for (const kind of ["failed", "timeout", "unsupported"] as const) {
      source.failWith("a1", kind);
      const error = await source
        .list("a1", { offset: 0, limit: 10 }, signal)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ItemSourceError);
      expect((error as ItemSourceError).kind).toBe(kind);
    }
    source.failWith("a1", null);
    await expect(
      source.list("a1", { offset: 0, limit: 10 }, signal),
    ).resolves.toBeTruthy();
  });

  it("未知のアセットは unsupported", async () => {
    const source = new FakeItemSource();
    const error = await source
      .list("nope", { offset: 0, limit: 1 }, signal)
      .catch((e: unknown) => e);
    expect((error as ItemSourceError).kind).toBe("unsupported");
  });

  it("中断されたら、読み込みを止める", async () => {
    const source = new FakeItemSource();
    source.setItems("a1", 5, {}, { delayMs: 50 });
    const controller = new AbortController();
    const pending = source.list(
      "a1",
      { offset: 0, limit: 10 },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("list の呼び出しを記録する", async () => {
    const source = new FakeItemSource();
    source.setItems("a1", 5);
    await source.list("a1", { offset: 0, limit: 2 }, signal);
    expect(source.calls).toEqual([
      { assetId: "a1", range: { offset: 0, limit: 2 } },
    ]);
  });
});

describe("HostItemSource", () => {
  const traits = [
    { media_type: "x/doc", work_unit: "item" as const, provider: "x/pages" },
    {
      media_type: "x/browse",
      work_unit: "asset" as const,
      provider: "x/pages",
    },
  ];

  it("宣言の一覧から、作業単位とアイテム提供の有無を答える", async () => {
    const source = createHostItemSource(async () => traits);
    await source.refresh();
    expect(source.traitsOf("x/doc")).toEqual({
      workUnit: "item",
      provider: "x/pages",
      hasItems: true,
    });
    expect(source.traitsOf("x/browse").workUnit).toBe("asset");
    expect(source.traitsOf("x/browse").hasItems).toBe(true);
    expect(source.traitsOf("x/none")).toEqual({
      workUnit: "asset",
      provider: null,
      hasItems: false,
    });
    expect(source.traitsOf(null).hasItems).toBe(false);
    expect(source.itemMediaTypes()).toEqual(["x/doc"]);
  });

  it("読み込みに失敗しても、既定のまま続ける（画面を止めない）", async () => {
    const source = createHostItemSource(async () => {
      throw new Error("x");
    });
    await expect(source.refresh()).resolves.toBeUndefined();
    expect(source.traitsOf("x/doc").hasItems).toBe(false);
  });

  it("提供元がまだ結ばれていないあいだの列挙は、unsupported", async () => {
    const source = createHostItemSource(async () => traits);
    const error = await source
      .list("a", { offset: 0, limit: 1 }, new AbortController().signal)
      .catch((e: unknown) => e);
    expect((error as ItemSourceError).kind).toBe("unsupported");
  });

  it("結ばれた提供元へ、列挙を渡す", async () => {
    const source = createHostItemSource(async () => traits);
    source.connect(async (assetId) => ({
      items: [{ key: assetId, title: "t" }],
      total: 1,
    }));
    const page = await source.list(
      "a",
      { offset: 0, limit: 1 },
      new AbortController().signal,
    );
    expect(page.items[0]?.key).toBe("a");
  });

  it("手元の宣言（デモ）は、宣言の読み直しで消えず、外せる", async () => {
    const source = createHostItemSource(async () => traits);
    source.declare("demo/x", {
      workUnit: "item",
      provider: "demo/p",
      hasItems: true,
    });
    await source.refresh();
    expect(source.traitsOf("demo/x").hasItems).toBe(true);
    expect(source.itemMediaTypes()).toContain("demo/x");
    source.undeclare("demo/x");
    expect(source.traitsOf("demo/x").hasItems).toBe(false);
  });
});
