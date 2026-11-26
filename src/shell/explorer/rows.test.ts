import { describe, expect, it } from "vitest";
import { FakeTreeIpc } from "../testing/fakes";
import { createRowsStore, PAGE_SIZE } from "./rows";
import type { TreeRow, ViewSpec } from "./types";

function assetRow(i: number): TreeRow {
  return {
    kind: "asset",
    id: `id-${i}`,
    name: `f${i}.txt`,
    depth: 1,
    media_type: null,
    status: "todo",
    missing: false,
    expanded: false,
    pinned: false,
  };
}

function ipcWith(count: number): FakeTreeIpc {
  const ipc = new FakeTreeIpc();
  ipc.setRows(Array.from({ length: count }, (_, i) => assetRow(i)));
  return ipc;
}

const SPEC: ViewSpec = {
  expanded_folders: [],
  expanded_assets: [],
  pinned: null,
};

function name(row: TreeRow | undefined): string | undefined {
  return row && "name" in row ? row.name : undefined;
}

describe("RowsStore", () => {
  it("見え方を設定すると総数が分かり、まだ行は取っていない", async () => {
    const ipc = ipcWith(1000);
    const store = createRowsStore(ipc);
    await store.setView(SPEC);
    expect(store.total()).toBe(1000);
    expect(ipc.rowCalls.length).toBe(0);
    expect(store.rowAt(0)).toBeUndefined();
  });

  it("可視範囲を含むページと、前後の 1 ページを取る", async () => {
    const ipc = ipcWith(1000);
    const store = createRowsStore(ipc);
    await store.setView(SPEC);
    await store.ensure(250, 270);
    const offsets = ipc.rowCalls.map((c) => c.offset).sort((a, b) => a - b);
    expect(offsets).toEqual([100, 200, 300]);
    expect(ipc.rowCalls.every((c) => c.limit === PAGE_SIZE)).toBe(true);
    expect(name(store.rowAt(255))).toBe("f255.txt");
    expect(name(store.rowAt(150))).toBe("f150.txt");
  });

  it("取得済みのページは取り直さない", async () => {
    const ipc = ipcWith(1000);
    const store = createRowsStore(ipc);
    await store.setView(SPEC);
    await store.ensure(0, 30);
    const first = ipc.rowCalls.length;
    await store.ensure(10, 40);
    expect(ipc.rowCalls.length).toBe(first);
  });

  it("総数を超えるページは取らない", async () => {
    const ipc = ipcWith(150);
    const store = createRowsStore(ipc);
    await store.setView(SPEC);
    await store.ensure(100, 400);
    const offsets = ipc.rowCalls.map((c) => c.offset).sort((a, b) => a - b);
    expect(offsets).toEqual([0, 100]);
    expect(store.rowAt(149)).toBeDefined();
    expect(store.rowAt(150)).toBeUndefined();
  });

  it("版が古い（StaleView）と、同じ見え方を設定し直して、同じ範囲を取り直す", async () => {
    const ipc = ipcWith(300);
    const store = createRowsStore(ipc);
    await store.setView(SPEC);
    ipc.setRows(
      Array.from({ length: 300 }, (_, i) => ({
        ...assetRow(i),
        name: `g${i}`,
      })),
    );
    await store.ensure(0, 30);
    expect(ipc.viewCalls.length).toBe(2);
    expect(name(store.rowAt(3))).toBe("g3");
  });

  it("更新（refresh）のあいだも、古い行を見せ続け、取り直したら入れ替える", async () => {
    const ipc = ipcWith(300);
    const store = createRowsStore(ipc);
    await store.setView(SPEC);
    await store.ensure(0, 30);
    ipc.setRows(
      Array.from({ length: 300 }, (_, i) => ({
        ...assetRow(i),
        name: `g${i}`,
      })),
    );
    const refreshing = store.refresh();
    expect(name(store.rowAt(3))).toBe("f3.txt");
    await refreshing;
    await store.ensure(0, 30);
    expect(name(store.rowAt(3))).toBe("g3");
  });

  it("更新で総数が変わったら、反映する", async () => {
    const ipc = ipcWith(300);
    const store = createRowsStore(ipc);
    await store.setView(SPEC);
    ipc.setRows(Array.from({ length: 120 }, (_, i) => assetRow(i)));
    await store.refresh();
    expect(store.total()).toBe(120);
  });

  it("古い版の遅れた応答で、新しい表示を上書きしない", async () => {
    const ipc = ipcWith(300);
    const store = createRowsStore({
      treeViewSet: (spec) => ipc.treeViewSet(spec),
      treeLocate: (version, assetId) => ipc.treeLocate(version, assetId),
      treeRows: async (version, offset, limit) => {
        const window = await ipc.treeRows(version, offset, limit);
        if (version === 1) await new Promise((r) => setTimeout(r, 30));
        return window;
      },
    });
    await store.setView(SPEC);
    const slow = store.ensure(0, 10); // 版 1 の取得（遅い）
    ipc.setRows(
      Array.from({ length: 300 }, (_, i) => ({
        ...assetRow(i),
        name: `new${i}`,
      })),
    );
    await store.setView(SPEC); // 版 2
    await store.ensure(0, 10);
    await slow;
    expect(name(store.rowAt(1))).toBe("new1");
  });

  it("変化を購読者に知らせ、解除できる", async () => {
    const ipc = ipcWith(300);
    const store = createRowsStore(ipc);
    let count = 0;
    const off = store.subscribe(() => {
      count += 1;
    });
    await store.setView(SPEC);
    const afterView = count;
    expect(afterView).toBeGreaterThan(0);
    await store.ensure(0, 10);
    expect(count).toBeGreaterThan(afterView);
    off();
    const before = count;
    await store.ensure(250, 260);
    expect(count).toBe(before);
  });

  it("見え方の設定が失敗したら、総数は 0 のままで例外を呼び出し側へ返す", async () => {
    const store = createRowsStore({
      treeViewSet: async () => {
        throw { code: "not_open", message: "x" };
      },
      treeLocate: async () => null,
      treeRows: async () => {
        throw new Error("unreachable");
      },
    });
    await expect(store.setView(SPEC)).rejects.toMatchObject({
      code: "not_open",
    });
    expect(store.total()).toBe(0);
  });
});
