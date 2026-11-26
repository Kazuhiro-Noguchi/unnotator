import { describe, expect, it } from "vitest";
import { FakeItemSource } from "../../host/item-source";
import { createCurrentStore } from "./current";
import { EMPTY_FILTER } from "./filter";
import { markDoneAndNext, type NavPorts, navigate } from "./nav";
import type { Neighbor, TreeFilter } from "./types";

interface FakeAsset {
  id: string;
  mediaType: string | null;
  status: "todo" | "in_progress" | "done" | "review";
  missing?: boolean;
}

/** 偽のツリー順の並び。Rust の `neighbor` と同じ規則（リンク切れを飛ばす・端で止まる）。 */
function makePorts(assets: FakeAsset[], items = new FakeItemSource()) {
  const current = createCurrentStore();
  const applied: Array<{
    assetId: string;
    itemKey: string | null;
    status: string;
  }> = [];
  const recorded = new Map<
    string,
    Array<{ key: string; status: FakeAsset["status"] }>
  >();
  let failApply = false;
  const neighborCalls: Array<{ unfinishedOnly: boolean; itemMedia: string[] }> =
    [];
  const ports: NavPorts = {
    async neighbor(
      from,
      direction,
      unfinishedOnly,
      _filter: TreeFilter,
      itemMedia,
    ): Promise<Neighbor> {
      neighborCalls.push({ unfinishedOnly, itemMedia });
      const at = from === null ? -1 : assets.findIndex((a) => a.id === from);
      const step = direction === "next" ? 1 : -1;
      let i =
        from === null
          ? direction === "next"
            ? 0
            : assets.length - 1
          : at + step;
      let skipped = 0;
      for (; i >= 0 && i < assets.length; i += step) {
        const a = assets[i];
        if (!a) continue;
        const unfinished =
          a.status !== "done" ||
          (a.mediaType !== null && itemMedia.includes(a.mediaType));
        if (unfinishedOnly && !unfinished) continue;
        if (a.missing) {
          skipped += 1;
          continue;
        }
        return {
          asset_id: a.id,
          media_type: a.mediaType,
          status: a.status,
          skipped_missing: skipped,
          reached_end: false,
        };
      }
      return {
        asset_id: null,
        media_type: null,
        status: null,
        skipped_missing: skipped,
        reached_end: true,
      };
    },
    traitsOf: (m) => items.traitsOf(m),
    itemMediaTypes: () => items.itemMediaTypes(),
    items,
    async recordedStatuses(assetId) {
      return recorded.get(assetId) ?? [];
    },
    async applyStatus(target, status) {
      if (failApply) throw new Error("write failed");
      applied.push({
        assetId: target.assetId,
        itemKey: target.itemKey,
        status,
      });
    },
    current,
    filter: () => EMPTY_FILTER,
  };
  return {
    ports,
    current,
    applied,
    items,
    recorded,
    neighborCalls,
    failApply: (v: boolean) => {
      failApply = v;
    },
  };
}

const A = (
  id: string,
  status: FakeAsset["status"] = "todo",
  extra: Partial<FakeAsset> = {},
): FakeAsset => ({
  id,
  mediaType: null,
  status,
  ...extra,
});

const open = (
  ctx: ReturnType<typeof makePorts>,
  assetId: string,
  mediaType: string | null = null,
  itemKey: string | null = null,
) => ctx.current.open({ assetId, itemKey, mediaType });

describe("navigate: アセット単位", () => {
  it("次へ・前へ", async () => {
    const t = makePorts([A("a"), A("b"), A("c")]);
    open(t, "a");
    expect(await navigate(t.ports, "next", false)).toMatchObject({
      kind: "moved",
      target: { assetId: "b" },
    });
    expect(t.current.get()?.assetId).toBe("b");
    expect(await navigate(t.ports, "prev", false)).toMatchObject({
      kind: "moved",
      target: { assetId: "a" },
    });
  });

  it("何も開いていないときは、先頭 / 末尾から", async () => {
    const t = makePorts([A("a"), A("b")]);
    expect(await navigate(t.ports, "next", false)).toMatchObject({
      target: { assetId: "a" },
    });
    const u = makePorts([A("a"), A("b")]);
    expect(await navigate(u.ports, "prev", false)).toMatchObject({
      target: { assetId: "b" },
    });
  });

  it("次の未完了は、完了済みを飛ばす（要確認・作業中は未完了）", async () => {
    const t = makePorts([
      A("a"),
      A("b", "done"),
      A("c", "review"),
      A("d", "done"),
      A("e", "in_progress"),
    ]);
    open(t, "a");
    expect(await navigate(t.ports, "next", true)).toMatchObject({
      target: { assetId: "c" },
    });
    expect(await navigate(t.ports, "next", true)).toMatchObject({
      target: { assetId: "e" },
    });
  });

  it("端で止まって end を返し、位置は動かさない", async () => {
    const t = makePorts([A("a"), A("b")]);
    open(t, "b");
    expect(await navigate(t.ports, "next", false)).toEqual({
      kind: "end",
      direction: "next",
    });
    expect(t.current.get()?.assetId).toBe("b");
    open(t, "a");
    expect(await navigate(t.ports, "prev", false)).toEqual({
      kind: "end",
      direction: "prev",
    });
  });

  it("未完了が無ければ nothing-unfinished", async () => {
    const t = makePorts([A("a"), A("b", "done")]);
    open(t, "a");
    expect(await navigate(t.ports, "next", true)).toEqual({
      kind: "nothing-unfinished",
    });
  });

  it("リンク切れを飛ばして、飛ばした数を返す", async () => {
    const t = makePorts([A("a"), A("b", "todo", { missing: true }), A("c")]);
    open(t, "a");
    expect(await navigate(t.ports, "next", false)).toMatchObject({
      target: { assetId: "c" },
      skippedMissing: 1,
    });
  });

  it("現在のフィルターを探索に渡す", async () => {
    const t = makePorts([A("a"), A("b")]);
    let seen: TreeFilter | null = null;
    const ports: NavPorts = {
      ...t.ports,
      filter: () => ({ ...EMPTY_FILTER, name: "x" }),
      neighbor: async (from, direction, u, filter, itemMedia) => {
        seen = filter;
        return t.ports.neighbor(from, direction, u, filter, itemMedia);
      },
    };
    await navigate(ports, "next", false);
    expect((seen as TreeFilter | null)?.name).toBe("x");
  });
});

describe("navigate: アイテム単位", () => {
  function itemWorld() {
    const items = new FakeItemSource();
    items.declare("t/doc", {
      workUnit: "item",
      hasItems: true,
      provider: "t/pages",
    });
    const t = makePorts(
      [
        { id: "p1", mediaType: "t/doc", status: "todo" },
        { id: "p2", mediaType: "t/doc", status: "todo" },
        A("plain"),
      ],
      items,
    );
    items.setItems("p1", 3);
    items.setItems("p2", 2);
    return { ...t, items };
  }

  it("同じアセットの次のアイテムへ進む", async () => {
    const t = itemWorld();
    open(t, "p1", "t/doc", "item:0");
    expect(await navigate(t.ports, "next", false)).toMatchObject({
      target: { assetId: "p1", itemKey: "item:1" },
    });
  });

  it("最後のアイテムの次は、次のアセットの最初のアイテム", async () => {
    const t = itemWorld();
    open(t, "p1", "t/doc", "item:2");
    expect(await navigate(t.ports, "next", false)).toMatchObject({
      target: { assetId: "p2", itemKey: "item:0" },
    });
  });

  it("前へは、前のアセットの最後のアイテムへ戻る", async () => {
    const t = itemWorld();
    open(t, "p2", "t/doc", "item:0");
    expect(await navigate(t.ports, "prev", false)).toMatchObject({
      target: { assetId: "p1", itemKey: "item:2" },
    });
  });

  it("アイテム単位のアセットの次が、アセット単位のアセットなら、そのアセットを開く", async () => {
    const t = itemWorld();
    open(t, "p2", "t/doc", "item:1");
    expect(await navigate(t.ports, "next", false)).toMatchObject({
      target: { assetId: "plain", itemKey: null },
    });
  });

  it("未完了は、記録された状態と提供元の状態を合成して決める（記録が優先、無ければ未着手）", async () => {
    const t = itemWorld();
    t.items.setItems("p1", 4, { "item:1": "done" });
    t.recorded.set("p1", [
      { key: "item:2", status: "done" },
      { key: "item:1", status: "todo" },
    ]);
    open(t, "p1", "t/doc", "item:0");
    // item:1 は記録が todo（提供元は done）→ 未完了。
    expect(await navigate(t.ports, "next", true)).toMatchObject({
      target: { itemKey: "item:1" },
    });
    // item:2 は記録が done → 飛ばし、item:3（記録なし = 未着手）へ。
    expect(await navigate(t.ports, "next", true)).toMatchObject({
      target: { itemKey: "item:3" },
    });
  });

  it("全部完了のアイテム単位のアセットは、未完了の探索で飛ばす", async () => {
    const t = itemWorld();
    t.recorded.set("p2", [
      { key: "item:0", status: "done" },
      { key: "item:1", status: "done" },
    ]);
    open(t, "p1", "t/doc", "item:2");
    expect(await navigate(t.ports, "next", true)).toMatchObject({
      target: { assetId: "plain" },
    });
  });

  it("アイテム単位の媒体は、完了済みでも探索から外さないよう、Rust に伝える", async () => {
    const t = itemWorld();
    t.items.declare("t/other", {
      workUnit: "asset",
      hasItems: true,
      provider: "t/x",
    });
    open(t, "p1", "t/doc", "item:2");
    await navigate(t.ports, "next", true);
    expect(t.neighborCalls.at(-1)?.unfinishedOnly).toBe(true);
    expect(t.neighborCalls.at(-1)?.itemMedia).toEqual(["t/doc"]);
  });

  it("提供元が失敗したら failed(source) で、位置は動かさない", async () => {
    const t = itemWorld();
    open(t, "p1", "t/doc", "item:0");
    t.items.failWith("p1", "failed");
    expect(await navigate(t.ports, "next", false)).toEqual({
      kind: "failed",
      reason: "source",
    });
    expect(t.current.get()?.itemKey).toBe("item:0");
  });
});

describe("markDoneAndNext", () => {
  it("開いているものを完了にして、次の未完了へ進む（1 回の操作）", async () => {
    const t = makePorts([A("a"), A("b", "done"), A("c")]);
    open(t, "a");
    const result = await markDoneAndNext(t.ports);
    expect(result).toMatchObject({ kind: "moved", target: { assetId: "c" } });
    expect(t.applied).toEqual([
      { assetId: "a", itemKey: null, status: "done" },
    ]);
  });

  it("アイテムなら、アイテムの状態を完了にする", async () => {
    const items = new FakeItemSource();
    items.declare("t/doc", {
      workUnit: "item",
      hasItems: true,
      provider: "t/pages",
    });
    const t = makePorts(
      [{ id: "p1", mediaType: "t/doc", status: "todo" }],
      items,
    );
    items.setItems("p1", 2);
    open(t, "p1", "t/doc", "item:0");
    const result = await markDoneAndNext(t.ports);
    expect(t.applied).toEqual([
      { assetId: "p1", itemKey: "item:0", status: "done" },
    ]);
    expect(result).toMatchObject({
      target: { assetId: "p1", itemKey: "item:1" },
    });
  });

  it("書き込みが失敗したら、移動しない", async () => {
    const t = makePorts([A("a"), A("b")]);
    open(t, "a");
    t.failApply(true);
    expect(await markDoneAndNext(t.ports)).toEqual({
      kind: "failed",
      reason: "write",
    });
    expect(t.current.get()?.assetId).toBe("a");
  });

  it("最後の未完了なら、完了にだけして nothing-unfinished", async () => {
    const t = makePorts([A("a"), A("b", "done")]);
    open(t, "a");
    expect(await markDoneAndNext(t.ports)).toEqual({
      kind: "nothing-unfinished",
    });
    expect(t.applied.length).toBe(1);
    expect(t.current.get()?.assetId).toBe("a");
  });

  it("何も開いていなければ、何もしない", async () => {
    const t = makePorts([A("a")]);
    expect(await markDoneAndNext(t.ports)).toEqual({
      kind: "nothing-unfinished",
    });
    expect(t.applied).toEqual([]);
  });
});

describe("1,000 件を完了にして次へで順に処理する（SC-005）", () => {
  it("未完了を 1 件も飛ばさず、完了済みを 1 件も開かない", async () => {
    const assets: FakeAsset[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `a${i}`,
      mediaType: null,
      status: i % 3 === 0 ? "done" : i % 3 === 1 ? "review" : "todo",
    }));
    const t = makePorts(assets);
    const visited: string[] = [];
    let result = await navigate(t.ports, "next", true);
    while (result.kind === "moved") {
      visited.push(result.target.assetId);
      result = await markDoneAndNext(t.ports);
    }
    const expected = assets.filter((a) => a.status !== "done").map((a) => a.id);
    expect(visited).toEqual(expected);
  });
});
