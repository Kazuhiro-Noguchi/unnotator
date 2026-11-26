import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEmitter, FakeTreeIpc, FakeUserSettings } from "../testing/fakes";
import { createContext } from "../when/context";
import { createExplorerSession } from "./session";
import type { TreeRow } from "./types";

const row = (i: number): TreeRow => ({
  kind: "asset",
  id: `id${i}`,
  name: `f${i}`,
  depth: 1,
  media_type: null,
  status: "todo",
  missing: false,
  expanded: false,
  pinned: false,
});

function setup(saved: Record<string, unknown> = {}) {
  const ipc = new FakeTreeIpc();
  ipc.setRows([row(0), row(1), row(2)]);
  const settings = new FakeUserSettings(saved);
  const changes = new FakeEmitter<void>();
  const ctx = createContext();
  const session = createExplorerSession({
    ipc,
    settings: {
      readUserLayer: async () => JSON.parse(await settings.layer()),
      write: (key, value) => settings.set(key, JSON.stringify(value)),
    },
    ctx,
    onChanged: (handler) => changes.listen(handler),
  });
  return { ipc, settings, changes, ctx, session };
}

describe("ExplorerSession", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("開くと、保存された開いたフォルダで見え方を設定する", async () => {
    const { ipc, session } = setup({
      "ui.explorer": { "/p": [":a", "ext:x/y"] },
    });
    await session.open("/p");
    expect(ipc.viewCalls.at(-1)?.expanded_folders).toEqual([
      { root_key: "", path: "a" },
      { root_key: "ext", path: "x/y" },
    ]);
    expect(session.rows.total()).toBe(3);
  });

  it("保存が無ければ、プロジェクトのルートだけを開く", async () => {
    const { ipc, session } = setup();
    await session.open("/p");
    expect(ipc.viewCalls.at(-1)?.expanded_folders).toEqual([
      { root_key: "", path: "" },
    ]);
  });

  it("現在位置があるかどうかを、コンテキストに反映する", async () => {
    const { ctx, session } = setup();
    await session.open("/p");
    expect(ctx.get("hasCurrent")).toBe(false);
    session.current.open({ assetId: "id1", itemKey: null, mediaType: null });
    expect(ctx.get("hasCurrent")).toBe(true);
    session.current.clear();
    expect(ctx.get("hasCurrent")).toBe(false);
  });

  it("閉じると、現在位置を消し、開閉を書き出し、行を空にする", async () => {
    const { settings, ctx, session } = setup();
    await session.open("/p");
    session.current.open({ assetId: "id1", itemKey: null, mediaType: null });
    await session.controller.toggle({
      kind: "folder",
      root_key: "",
      path: "a",
      name: "a",
      depth: 1,
      expanded: false,
      total: 1,
      done: 0,
    });
    await session.close();
    expect(session.current.get()).toBeNull();
    expect(ctx.get("hasCurrent")).toBe(false);
    expect(session.rows.total()).toBe(0);
    const written = settings.values["ui.explorer"] as Record<string, string[]>;
    expect(written["/p"]).toContain(":a");
  });

  it("アセットの変化を受けると、少し待ってから窓を取り直す", async () => {
    const { ipc, changes, session } = setup();
    await session.open("/p");
    const before = ipc.viewCalls.length;
    changes.emit();
    changes.emit();
    changes.emit();
    await vi.advanceTimersByTimeAsync(40);
    expect(ipc.viewCalls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(100);
    expect(ipc.viewCalls.length).toBe(before + 1);
  });

  it("開いていないあいだの変化は、無視する", async () => {
    const { ipc, changes, session } = setup();
    await session.open("/p");
    await session.close();
    const before = ipc.viewCalls.length;
    changes.emit();
    await vi.advanceTimersByTimeAsync(500);
    expect(ipc.viewCalls.length).toBe(before);
  });

  it("別のプロジェクトを開くと、前の開閉は引き継がない", async () => {
    const { ipc, session } = setup({ "ui.explorer": { "/p": [":a"] } });
    await session.open("/p");
    await session.close();
    await session.open("/q");
    expect(ipc.viewCalls.at(-1)?.expanded_folders).toEqual([
      { root_key: "", path: "" },
    ]);
  });

  it("フィルターが有効かどうかを、コンテキストに反映する", async () => {
    const { ctx, session } = setup();
    await session.open("/p");
    expect(ctx.get("filterActive")).toBe(false);
    await session.controller.setFilter({
      name: "x",
      statuses: [],
      media_types: [],
      missing: null,
    });
    expect(ctx.get("filterActive")).toBe(true);
    await session.controller.setFilter({
      name: null,
      statuses: [],
      media_types: [],
      missing: null,
    });
    expect(ctx.get("filterActive")).toBe(false);
  });

  it("拡張機能が 1 つも無い構成（アイテムの提供元なし）でも、ツリーが動く（SC-010）", async () => {
    const { ipc, session } = setup();
    await session.open("/p");
    expect(session.rows.total()).toBe(3);
    expect(session.controller.items).toBeUndefined();
    const first = session.rows.rowAt(0);
    expect(first && session.controller.canExpand(first)).toBe(false);
    await session.controller.activate(0);
    expect(session.current.get()).toEqual({
      assetId: "id0",
      itemKey: null,
      mediaType: null,
    });
    expect(ipc.viewCalls.length).toBeGreaterThan(0);
  });
});
