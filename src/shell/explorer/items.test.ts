import { describe, expect, it } from "vitest";
import { FakeItemSource } from "../../host/item-source";
import { createItemRows, ITEM_PAGE_SIZE } from "./items";

function setup(count = 250, statuses: Record<string, "done"> = {}) {
  const source = new FakeItemSource();
  source.setItems("a1", count, statuses);
  const recorded = new Map<
    string,
    Array<{ key: string; status: "todo" | "in_progress" | "done" | "review" }>
  >();
  const rows = createItemRows({
    source,
    recordedStatuses: async (id) => recorded.get(id) ?? [],
  });
  return { source, rows, recorded };
}

describe("ItemRows", () => {
  it("開くと、最初のページを取って、総数を返す", async () => {
    const { rows, source } = setup(250);
    expect(await rows.open("a1")).toBe(250);
    expect(rows.total("a1")).toBe(250);
    expect(source.calls).toEqual([
      { assetId: "a1", range: { offset: 0, limit: ITEM_PAGE_SIZE } },
    ]);
    expect(rows.cell("a1", 5)).toMatchObject({
      kind: "item",
      info: { key: "item:5" },
      status: "todo",
    });
  });

  it("総数を知らない提供元は、短いページが来るまで数える", async () => {
    const source = new FakeItemSource();
    source.setItems("a1", 230, {}, { hideTotal: true });
    const rows = createItemRows({ source, recordedStatuses: async () => [] });
    expect(await rows.open("a1")).toBe(230);
    expect(source.calls.length).toBe(3);
  });

  it("ちょうどページの倍数で、総数が不明でも、最後に空のページで終わる", async () => {
    const source = new FakeItemSource();
    source.setItems("a1", ITEM_PAGE_SIZE * 2, {}, { hideTotal: true });
    const rows = createItemRows({ source, recordedStatuses: async () => [] });
    expect(await rows.open("a1")).toBe(ITEM_PAGE_SIZE * 2);
  });

  it("窓に入った枠のページだけを、あとから取る", async () => {
    const { rows, source } = setup(1000);
    await rows.open("a1");
    expect(rows.cell("a1", 450)).toEqual({ kind: "loading" });
    await rows.ensure("a1", 450, 470);
    expect(rows.cell("a1", 450)).toMatchObject({
      kind: "item",
      info: { key: "item:450" },
    });
    const offsets = source.calls.map((c) => c.range.offset);
    expect(offsets).toContain(400);
    expect(offsets).not.toContain(900);
  });

  it("取得済みのページは、取り直さない", async () => {
    const { rows, source } = setup(300);
    await rows.open("a1");
    const before = source.calls.length;
    await rows.ensure("a1", 0, 50);
    expect(source.calls.length).toBe(before);
  });

  it("状態は、記録を優先し、無ければ提供元の状態、それも無ければ未着手", async () => {
    const { rows, recorded } = setup(5, { "item:1": "done" });
    recorded.set("a1", [
      { key: "item:2", status: "review" },
      { key: "item:1", status: "todo" },
    ]);
    await rows.open("a1");
    expect(rows.cell("a1", 0)).toMatchObject({ status: "todo" });
    expect(rows.cell("a1", 1)).toMatchObject({ status: "todo" }); // 記録が優先
    expect(rows.cell("a1", 2)).toMatchObject({ status: "review" });
    const noRecord = setup(3, { "item:1": "done" });
    await noRecord.rows.open("a1");
    expect(noRecord.rows.cell("a1", 1)).toMatchObject({ status: "done" });
  });

  it("状態の記録を読み直すと、表示の状態が変わる", async () => {
    const { rows, recorded } = setup(3);
    await rows.open("a1");
    recorded.set("a1", [{ key: "item:0", status: "done" }]);
    await rows.refreshStatuses();
    expect(rows.cell("a1", 0)).toMatchObject({ status: "done" });
  });

  it("提供元の失敗は、そのアセットの中だけに閉じ込め、ほかには影響しない", async () => {
    const source = new FakeItemSource();
    source.setItems("a1", 5);
    source.setItems("a2", 5);
    source.failWith("a1", "failed");
    const rows = createItemRows({ source, recordedStatuses: async () => [] });
    expect(await rows.open("a1")).toBeNull();
    expect(rows.state("a1")).toEqual({ kind: "error", error: "failed" });
    expect(await rows.open("a2")).toBe(5);
    expect(rows.state("a2")).toEqual({ kind: "ready" });
  });

  it("時間切れ・未対応も、種類つきで伝える", async () => {
    const source = new FakeItemSource();
    source.setItems("a1", 5);
    source.failWith("a1", "timeout");
    const rows = createItemRows({ source, recordedStatuses: async () => [] });
    await rows.open("a1");
    expect(rows.state("a1")).toEqual({ kind: "error", error: "timeout" });
    source.failWith("a1", "unsupported");
    await rows.retry("a1");
    expect(rows.state("a1")).toEqual({ kind: "unsupported" });
  });

  it("再試行で、直った提供元から取り直す", async () => {
    const { rows, source } = setup(5);
    source.failWith("a1", "failed");
    await rows.open("a1");
    source.failWith("a1", null);
    expect(await rows.retry("a1")).toBe(5);
    expect(rows.state("a1")).toEqual({ kind: "ready" });
    expect(rows.cell("a1", 0)).toMatchObject({ kind: "item" });
  });

  it("後のページの失敗は、その枠だけがエラーで、再試行できる", async () => {
    const { rows, source } = setup(300);
    await rows.open("a1");
    source.failWith("a1", "timeout");
    await rows.ensure("a1", 250, 260).catch(() => {});
    expect(rows.cell("a1", 255)).toEqual({ kind: "error", error: "timeout" });
    source.failWith("a1", null);
    await rows.retry("a1");
    await rows.ensure("a1", 250, 260);
    expect(rows.cell("a1", 255)).toMatchObject({ kind: "item" });
  });

  it("閉じると、キャッシュを捨てる（記録は消さない）", async () => {
    const { rows } = setup(5);
    await rows.open("a1");
    rows.close("a1");
    expect(rows.total("a1")).toBeNull();
    expect(rows.cell("a1", 0)).toEqual({ kind: "loading" });
  });

  it("開き直す前に閉じられたら、古い取得の結果を捨てる", async () => {
    const source = new FakeItemSource();
    source.setItems("a1", 5, {}, { delayMs: 20 });
    const rows = createItemRows({ source, recordedStatuses: async () => [] });
    const pending = rows.open("a1");
    rows.close("a1");
    await pending;
    expect(rows.total("a1")).toBeNull();
  });

  it("変化を購読者に知らせる", async () => {
    const { rows } = setup(5);
    let count = 0;
    rows.subscribe(() => {
      count += 1;
    });
    await rows.open("a1");
    expect(count).toBeGreaterThan(0);
  });
});
