import { describe, expect, it, vi } from "vitest";
import { makeProblemSink } from "../testing/fakes";
import { createContext } from "../when/context";
import { declareCoreCommands } from "./core-commands";
import { provideCoreHandlers } from "./core-handlers";
import { createCommandRegistry } from "./registry";

function setup() {
  const ctx = createContext();
  const { sink, problems } = makeProblemSink();
  const commands = createCommandRegistry({
    ctx,
    report: sink,
    notify: vi.fn(),
  });
  declareCoreCommands(commands);
  const actions = {
    openFolder: vi.fn(async () => {}),
    createNew: vi.fn(async () => {}),
    openRecent: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    undo: vi.fn(async () => {}),
    redo: vi.fn(async () => {}),
  };
  const layout = { toggle: vi.fn(), showPrimarySidebarView: vi.fn() };
  const appearance = { setTheme: vi.fn(), setLanguage: vi.fn() };
  const ui = {
    openPalette: vi.fn(),
    openSettings: vi.fn(),
    openAbout: vi.fn(),
  };
  const handle = provideCoreHandlers({
    commands,
    actions,
    layout,
    appearance,
    ...ui,
  });
  return { ctx, commands, actions, layout, appearance, ui, handle, problems };
}

describe("コアの処理の結びつけ", () => {
  it("存在するコマンドだけに結ぶ（未登録への provide で問題が出ない）", () => {
    const { problems } = setup();
    expect(problems).toEqual([]);
  });

  it("元に戻す・やり直しは、条件が整うと実行される", async () => {
    const { commands, ctx, actions } = setup();
    expect((await commands.execute("core.undo")).ok).toBe(false);
    ctx.set("canUndo", true);
    expect((await commands.execute("core.undo")).ok).toBe(true);
    expect(actions.undo).toHaveBeenCalledTimes(1);
    ctx.set("canRedo", true);
    await commands.execute("core.redo");
    expect(actions.redo).toHaveBeenCalledTimes(1);
  });

  it("保存はプロジェクトが開いているときだけ", async () => {
    const { commands, ctx, actions } = setup();
    expect((await commands.execute("core.project.save")).ok).toBe(false);
    ctx.set("projectOpen", true);
    await commands.execute("core.project.save");
    expect(actions.save).toHaveBeenCalledTimes(1);
  });

  it("フォルダを開く・新規・最近（引数のパス）", async () => {
    const { commands, actions } = setup();
    await commands.execute("core.project.open");
    await commands.execute("core.project.new");
    await commands.execute("core.project.openRecent", "/p");
    expect(actions.openFolder).toHaveBeenCalledTimes(1);
    expect(actions.createNew).toHaveBeenCalledTimes(1);
    expect(actions.openRecent).toHaveBeenCalledWith("/p");
  });

  it("領域の表示切替とサイドバーの入口", async () => {
    const { commands, layout } = setup();
    await commands.execute("core.view.bottom.toggle");
    await commands.execute("core.primarySidebar.show.search");
    expect(layout.toggle).toHaveBeenCalledWith("bottom");
    expect(layout.showPrimarySidebarView).toHaveBeenCalledWith("search");
  });

  it("パレット・設定・バージョン情報", async () => {
    const { commands, ui } = setup();
    await commands.execute("core.palette.open");
    await commands.execute("core.app.settings");
    await commands.execute("core.app.about");
    expect(ui.openPalette).toHaveBeenCalledTimes(1);
    expect(ui.openSettings).toHaveBeenCalledTimes(1);
    expect(ui.openAbout).toHaveBeenCalledTimes(1);
  });

  it("テーマと言語の選択は、引数を検証して適用する", async () => {
    const { commands, appearance } = setup();
    await commands.execute("core.view.theme.set", "dark");
    await commands.execute("core.view.theme.set", "purple");
    await commands.execute("core.view.language.set", "en");
    await commands.execute("core.view.language.set", 3);
    expect(appearance.setTheme).toHaveBeenCalledTimes(1);
    expect(appearance.setTheme).toHaveBeenCalledWith("dark");
    expect(appearance.setLanguage).toHaveBeenCalledTimes(1);
    expect(appearance.setLanguage).toHaveBeenCalledWith("en");
  });

  it("後続の機能のコマンドは、未提供のまま", () => {
    const { commands } = setup();
    expect(commands.availability("core.edit.copy")()).toEqual({
      enabled: false,
      reason: "unprovided",
    });
    expect(commands.availability("core.nav.next")()).toEqual({
      enabled: false,
      reason: "unprovided",
    });
  });

  it("dispose で、処理が外れる", () => {
    const { commands, handle } = setup();
    handle.dispose();
    expect(commands.availability("core.palette.open")()).toEqual({
      enabled: false,
      reason: "unprovided",
    });
  });
});
