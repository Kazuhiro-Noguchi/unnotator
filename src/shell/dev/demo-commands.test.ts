import { describe, expect, it, vi } from "vitest";
import { declareCoreCommands } from "../commands/core-commands";
import { createCommandRegistry } from "../commands/registry";
import { makeProblemSink } from "../testing/fakes";
import { createContext } from "../when/context";
import { installDemoCommands } from "./demo-commands";

function setup() {
  const ctx = createContext();
  const { sink } = makeProblemSink();
  const notify = vi.fn();
  const commands = createCommandRegistry({ ctx, report: sink, notify });
  declareCoreCommands(commands);
  return {
    ctx,
    commands,
    notify,
    handle: installDemoCommands({ commands, ctx, notify }),
  };
}

describe("開発用のデモのコマンド", () => {
  it("プロジェクトの状態を切り替えるデモのコマンドが、パレットに出る", async () => {
    const { commands, ctx } = setup();
    expect(commands.get("dev.demo.toggleProject")?.source).toBe("dev");
    expect(ctx.get("projectOpen")).toBe(false);
    await commands.execute("dev.demo.toggleProject");
    expect(ctx.get("projectOpen")).toBe(true);
    await commands.execute("dev.demo.toggleProject");
    expect(ctx.get("projectOpen")).toBe(false);
  });

  it("Undo / Redo / 未保存の状態を切り替えられる", async () => {
    const { commands, ctx } = setup();
    await commands.execute("dev.demo.toggleUndo");
    expect(ctx.get("canUndo")).toBe(true);
    expect(ctx.get("canRedo")).toBe(true);
    expect(ctx.get("projectDirty")).toBe(true);
  });

  it("未提供のコマンドに、仮の処理を結ばない（押せないまま）", () => {
    const { commands } = setup();
    expect(commands.availability("core.edit.copy")()).toEqual({
      enabled: false,
      reason: "unprovided",
    });
  });

  it("dispose で、デモのコマンドが外れる", () => {
    const { commands, handle } = setup();
    handle.dispose();
    expect(commands.get("dev.demo.toggleProject")).toBeUndefined();
  });
});
