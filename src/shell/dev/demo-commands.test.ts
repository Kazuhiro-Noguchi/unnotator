import { describe, expect, it, vi } from "vitest";
import { declareCoreCommands } from "../commands/core-commands";
import { createCommandRegistry } from "../commands/registry";
import { makeProblemSink } from "../testing/fakes";
import { createContext } from "../when/context";
import { DEMO_TOGGLES, installDemoCommands } from "./demo-commands";

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
  it("処理が無い（未提供の）コアのコマンドに、仮の処理を結ぶ", async () => {
    const { commands, notify } = setup();
    expect(commands.availability("core.edit.copy")()).toEqual({
      enabled: true,
    });
    await commands.execute("core.edit.copy");
    expect(notify).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("コピー"),
      { source: "Demo" },
    );
  });

  it("本物の処理がすでにあるコマンドには、触らない", async () => {
    const ctx = createContext();
    const { sink } = makeProblemSink();
    const notify = vi.fn();
    const commands = createCommandRegistry({ ctx, report: sink, notify });
    declareCoreCommands(commands);
    const real = vi.fn();
    commands.provide("core.edit.copy", real);
    installDemoCommands({ commands, ctx, notify });
    await commands.execute("core.edit.copy");
    expect(real).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("トグルは、コンテキストのキーを反転して、通知する", async () => {
    const { commands, ctx } = setup();
    for (const [command, key] of Object.entries(DEMO_TOGGLES)) {
      expect(ctx.get(key)).toBeNull();
      await commands.execute(command);
      expect(ctx.get(key), command).toBe(true);
      await commands.execute(command);
      expect(ctx.get(key), command).toBeNull();
    }
  });

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

  it("dispose で、仮の処理とデモのコマンドが外れる", () => {
    const { commands, handle } = setup();
    handle.dispose();
    expect(commands.get("dev.demo.toggleProject")).toBeUndefined();
    expect(commands.availability("core.edit.copy")()).toEqual({
      enabled: false,
      reason: "unprovided",
    });
  });
});
