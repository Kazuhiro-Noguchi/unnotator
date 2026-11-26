import { describe, expect, it, vi } from "vitest";
import { FakeItemSource } from "../../host/item-source";
import { t } from "../../i18n";
import { declareCoreCommands } from "../commands/core-commands";
import { createCommandRegistry } from "../commands/registry";
import { makeProblemSink } from "../testing/fakes";
import { createContext } from "../when/context";
import { provideExplorerHandlers } from "./commands";
import { createCurrentStore } from "./current";
import { EMPTY_FILTER } from "./filter";
import type { NavPorts } from "./nav";

function setup(
  neighbors: Array<{
    id: string | null;
    media?: string | null;
    skipped?: number;
  }> = [],
) {
  const ctx = createContext();
  const { sink } = makeProblemSink();
  const notify = vi.fn();
  const commands = createCommandRegistry({ ctx, report: sink, notify });
  declareCoreCommands(commands);
  const current = createCurrentStore();
  const items = new FakeItemSource();
  const applied: Array<{
    assetId: string;
    itemKey: string | null;
    status: string;
  }> = [];
  let failWrite = false;
  const queue = [...neighbors];
  const ports: NavPorts = {
    neighbor: async () => {
      const next = queue.shift() ?? { id: null };
      return next.id === null
        ? {
            asset_id: null,
            media_type: null,
            status: null,
            skipped_missing: next.skipped ?? 0,
            reached_end: true,
          }
        : {
            asset_id: next.id,
            media_type: next.media ?? null,
            status: "todo",
            skipped_missing: next.skipped ?? 0,
            reached_end: false,
          };
    },
    traitsOf: (m) => items.traitsOf(m),
    items,
    recordedStatuses: async () => [],
    applyStatus: async (target, status) => {
      if (failWrite) throw new Error("x");
      applied.push({
        assetId: target.assetId,
        itemKey: target.itemKey,
        status,
      });
    },
    current,
    filter: () => EMPTY_FILTER,
  };
  const handle = provideExplorerHandlers({ commands, ports, notify });
  return {
    ctx,
    commands,
    notify,
    current,
    applied,
    handle,
    failWrite: () => {
      failWrite = true;
    },
  };
}

describe("エクスプローラーのコマンド", () => {
  it("提供すると、ナビゲーションとの条件に従って有効になる", () => {
    const { commands, ctx } = setup();
    expect(commands.availability("core.nav.next")().enabled).toBe(false);
    ctx.set("projectOpen", true);
    expect(commands.availability("core.nav.next")().enabled).toBe(true);
    expect(commands.availability("core.nav.prev")().enabled).toBe(true);
    expect(commands.availability("core.nav.nextUnfinished")().enabled).toBe(
      true,
    );
    expect(commands.availability("core.nav.markDoneAndNext")().enabled).toBe(
      false,
    );
    ctx.set("hasCurrent", true);
    expect(commands.availability("core.nav.markDoneAndNext")().enabled).toBe(
      true,
    );
    expect(commands.availability("core.status.markDone")().enabled).toBe(true);
    expect(commands.availability("core.status.needsReview")().enabled).toBe(
      true,
    );
  });

  it("次へで移動する", async () => {
    const t1 = setup([{ id: "b" }]);
    t1.ctx.set("projectOpen", true);
    await t1.commands.execute("core.nav.next");
    expect(t1.current.get()?.assetId).toBe("b");
    expect(t1.notify).not.toHaveBeenCalled();
  });

  it("リンク切れを飛ばしたら、件数を知らせる", async () => {
    const x = setup([{ id: "b", skipped: 2 }]);
    x.ctx.set("projectOpen", true);
    await x.commands.execute("core.nav.next");
    expect(x.notify).toHaveBeenCalledWith("info", expect.stringContaining("2"));
  });

  it("端では、最後 / 先頭と知らせて、位置は動かさない", async () => {
    const x = setup([{ id: null }, { id: null }]);
    x.ctx.set("projectOpen", true);
    x.current.open({ assetId: "a", itemKey: null, mediaType: null });
    await x.commands.execute("core.nav.next");
    expect(x.notify).toHaveBeenLastCalledWith("info", t("explorer.nav.end"));
    await x.commands.execute("core.nav.prev");
    expect(x.notify).toHaveBeenLastCalledWith("info", t("explorer.nav.start"));
    expect(x.current.get()?.assetId).toBe("a");
  });

  it("未完了が無ければ、そう知らせる", async () => {
    const x = setup([{ id: null }]);
    x.ctx.set("projectOpen", true);
    await x.commands.execute("core.nav.nextUnfinished");
    expect(x.notify).toHaveBeenCalledWith(
      "info",
      t("explorer.nav.nothingUnfinished"),
    );
  });

  it("完了して次へは、状態を変えてから移動する", async () => {
    const x = setup([{ id: "b" }]);
    x.ctx.set("projectOpen", true);
    x.ctx.set("hasCurrent", true);
    x.current.open({ assetId: "a", itemKey: null, mediaType: null });
    await x.commands.execute("core.nav.markDoneAndNext");
    expect(x.applied).toEqual([
      { assetId: "a", itemKey: null, status: "done" },
    ]);
    expect(x.current.get()?.assetId).toBe("b");
  });

  it("書き込みの失敗は、通知して移動しない", async () => {
    const x = setup([{ id: "b" }]);
    x.ctx.set("projectOpen", true);
    x.ctx.set("hasCurrent", true);
    x.current.open({ assetId: "a", itemKey: null, mediaType: null });
    x.failWrite();
    await x.commands.execute("core.nav.markDoneAndNext");
    expect(x.notify).toHaveBeenCalledWith(
      "error",
      t("explorer.nav.failedWrite"),
    );
    expect(x.current.get()?.assetId).toBe("a");
  });

  it("完了・要確認のコマンドは、現在位置の状態を変える（アセット）", async () => {
    const x = setup();
    x.ctx.set("hasCurrent", true);
    x.current.open({ assetId: "a", itemKey: null, mediaType: null });
    await x.commands.execute("core.status.markDone");
    await x.commands.execute("core.status.needsReview");
    expect(x.applied).toEqual([
      { assetId: "a", itemKey: null, status: "done" },
      { assetId: "a", itemKey: null, status: "review" },
    ]);
  });

  it("アイテムを開いているときは、アイテムの状態を変える", async () => {
    const x = setup();
    x.ctx.set("hasCurrent", true);
    x.current.open({ assetId: "a", itemKey: "page:2", mediaType: "t/doc" });
    await x.commands.execute("core.status.markDone");
    expect(x.applied).toEqual([
      { assetId: "a", itemKey: "page:2", status: "done" },
    ]);
  });

  it("状態を変えられなかったら、通知する", async () => {
    const x = setup();
    x.ctx.set("hasCurrent", true);
    x.current.open({ assetId: "a", itemKey: null, mediaType: null });
    x.failWrite();
    await x.commands.execute("core.status.markDone");
    expect(x.notify).toHaveBeenCalledWith("error", t("explorer.status.failed"));
  });

  it("現在位置が無ければ、状態のコマンドは実行できない", async () => {
    const x = setup();
    const result = await x.commands.execute("core.status.markDone");
    expect(result.ok).toBe(false);
    expect(x.applied).toEqual([]);
  });

  it("dispose で、処理が外れる", () => {
    const x = setup();
    x.handle.dispose();
    expect(x.commands.availability("core.nav.next")()).toEqual({
      enabled: false,
      reason: "unprovided",
    });
  });
});
