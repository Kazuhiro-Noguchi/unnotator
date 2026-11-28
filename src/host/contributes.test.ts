import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry } from "../shell/commands/registry";
import { createKeymap } from "../shell/keys/keymap";
import { createRibbonModel } from "../shell/ribbon/model";
import { createStatusStore } from "../shell/status/store";
import { makeProblemSink } from "../shell/testing/fakes";
import { createContext } from "../shell/when/context";
import { createContributesSync } from "./contributes";
import type { ExtensionInfo } from "./service";

function info(
  id: string,
  contributes: Record<string, unknown>,
  status = "enabled",
): ExtensionInfo {
  return {
    id,
    version: "1.0.0",
    status,
    manifest:
      status === "enabled"
        ? JSON.stringify({ id, version: "1.0.0", contributes })
        : null,
  };
}

function setup(initial: ExtensionInfo[]) {
  const ctx = createContext();
  const { sink } = makeProblemSink();
  const commands = createCommandRegistry({
    ctx,
    report: sink,
    notify: vi.fn(),
  });
  const keymap = createKeymap({ ctx, report: sink, platform: "other" });
  const ribbon = createRibbonModel({ core: [], ctx, commands, report: sink });
  const status = createStatusStore();
  let infos = initial;
  const listeners = new Set<(i: readonly ExtensionInfo[]) => void>();
  const trigger = vi.fn(async (_event: string) => {});
  const sync = createContributesSync({
    targets: { ctx, commands, keymap, ribbon, status },
    host: {
      infos: () => infos,
      onDidRefresh: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      trigger,
    },
  });
  const refresh = (next: ExtensionInfo[]) => {
    infos = next;
    for (const l of [...listeners]) l(infos);
  };
  return { commands, keymap, ribbon, status, sync, refresh, trigger };
}

const draw = { commands: [{ id: "draw", title: "Draw" }] };

describe("contributes の反映（FR-011）", () => {
  it("有効化の前から、有効な拡張機能のコマンドを宣言する", () => {
    const t = setup([info("com.x", draw)]);
    t.sync.sync();
    expect(t.commands.get("com.x/draw")).toBeDefined();
  });

  it("一覧が更新されたら反映し、無効・削除で取り除く", () => {
    const t = setup([]);
    t.sync.start();
    t.refresh([info("com.x", draw)]);
    expect(t.commands.get("com.x/draw")).toBeDefined();
    t.refresh([info("com.x", draw, "disabled")]);
    expect(t.commands.get("com.x/draw")).toBeUndefined();
    t.refresh([info("com.x", draw)]);
    t.refresh([]);
    expect(t.commands.get("com.x/draw")).toBeUndefined();
  });

  it("キーと有効でない拡張機能の寄与は、無効にすると外れる", () => {
    const t = setup([
      info("com.x", {
        ...draw,
        keybindings: [{ key: "Ctrl+K", command: "com.x/draw" }],
      }),
    ]);
    t.sync.sync();
    expect(t.keymap.bindingsFor("com.x/draw")).toHaveLength(1);
    t.sync.start();
    t.refresh([]);
    expect(t.keymap.bindingsFor("com.x/draw")).toHaveLength(0);
  });

  it("中身が変わらない更新では、結ばれた処理を壊さない", () => {
    const t = setup([info("com.x", draw)]);
    t.sync.start();
    t.sync.sync();
    const run = vi.fn(async () => "real");
    t.commands.provide("com.x/draw", run);
    t.refresh([info("com.x", draw)]);
    expect(t.commands.get("com.x/draw")?.run).toBe(run);
  });

  it("壊れたマニフェストは無視する", () => {
    const t = setup([
      { id: "com.bad", version: "1", status: "enabled", manifest: "{" },
    ]);
    expect(() => t.sync.sync()).not.toThrow();
  });

  it("まだ有効でない拡張機能のコマンドは、実行時に onCommand を送ってから実行する", async () => {
    const t = setup([info("com.x", draw)]);
    t.sync.sync();
    t.trigger.mockImplementation(async () => {
      t.commands.provide("com.x/draw", async () => "real");
    });
    const result = await t.commands.execute("com.x/draw");
    expect(t.trigger).toHaveBeenCalledWith("onCommand:com.x/draw");
    expect(t.trigger).toHaveBeenCalledWith("onCommand:draw");
    expect(result).toEqual({ ok: true, value: "real" });
  });

  it("有効化しても処理が結ばれなければ、失敗にする", async () => {
    const t = setup([info("com.x", draw)]);
    t.sync.sync();
    const result = await t.commands.execute("com.x/draw");
    expect(result).toEqual({ ok: false, reason: "failed" });
  });
});
