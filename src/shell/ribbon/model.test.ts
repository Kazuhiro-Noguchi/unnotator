import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry } from "../commands/registry";
import { makeProblemSink } from "../testing/fakes";
import type { RibbonControl, RibbonTab } from "../types";
import { createContext } from "../when/context";
import { createRibbonModel } from "./model";

function tab(
  id: string,
  over: Partial<RibbonTab> = {},
  groups: RibbonTab["groups"] = [],
): RibbonTab {
  return {
    id,
    title: { ja: id },
    order: 10,
    groups,
    contextual: false,
    source: "core",
    ...over,
  };
}
const btn = (
  command: string,
  over: Partial<RibbonControl> = {},
): RibbonControl => ({
  kind: "largeButton",
  command,
  ...over,
});
const group = (
  id: string,
  controls: RibbonControl[],
  over: Record<string, unknown> = {},
) => ({
  id,
  title: { ja: id },
  priority: 0,
  controls,
  source: "core",
  ...over,
});

function setup(core: RibbonTab[]) {
  const ctx = createContext();
  const { sink, problems } = makeProblemSink();
  const commands = createCommandRegistry({
    ctx,
    report: sink,
    notify: vi.fn(),
  });
  const model = createRibbonModel({ core, ctx, commands, report: sink });
  return { ctx, commands, model, problems };
}

const decl = (
  commands: ReturnType<typeof createCommandRegistry>,
  id: string,
  extra = {},
) => commands.declare({ id, title: { ja: id }, source: "core", ...extra });

describe("リボンのモデル", () => {
  it("tabs() が、when が真のタブだけを返す", () => {
    const { model, ctx } = setup([tab("a"), tab("b", { when: "show" })]);
    expect(model.tabs().map((t) => t.id)).toEqual(["a"]);
    ctx.set("show", true);
    expect(model.tabs().map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("グループとコントロールの when も評価する", () => {
    const { model, ctx, commands } = setup([
      tab("a", {}, [
        group("g1", [btn("core.x"), btn("core.y", { when: "flag" })]),
        group("g2", [btn("core.x")], { when: "flag" }),
      ]),
    ]);
    decl(commands, "core.x");
    decl(commands, "core.y");
    const read = () =>
      model.tabs()[0]?.groups.map((g) => [g.id, g.controls.length]);
    expect(read()).toEqual([["g1", 1]]);
    ctx.set("flag", true);
    expect(read()).toEqual([
      ["g1", 2],
      ["g2", 1],
    ]);
  });

  it("when の変化で、購読（ctx.watch）が更新される", () => {
    const { model, ctx } = setup([tab("a"), tab("b", { when: "show" })]);
    const seen: number[] = [];
    ctx.watch(
      () => model.tabs().length,
      (n) => seen.push(n),
    );
    ctx.set("show", true);
    ctx.set("show", false);
    expect(seen).toEqual([2, 1]);
  });

  it("コントロールの状態: コマンドの有効 / 無効に追従する", () => {
    const { model, ctx, commands } = setup([
      tab("a", {}, [group("g", [btn("core.x")])]),
    ]);
    decl(commands, "core.x", { enablement: "ok", run: vi.fn() });
    const control = model.tabs()[0]?.groups[0]?.controls[0] as RibbonControl;
    expect(model.controlState(control).enabled).toBe(false);
    ctx.set("ok", true);
    expect(model.controlState(control).enabled).toBe(true);
    const seen: boolean[] = [];
    ctx.watch(
      () => model.controlState(control).enabled,
      (v) => seen.push(v),
    );
    ctx.set("ok", false);
    expect(seen).toEqual([false]);
  });

  it("未提供のコマンドを指す項目は無効（理由 unprovided）", () => {
    const { model, commands } = setup([
      tab("a", {}, [group("g", [btn("core.x")])]),
    ]);
    decl(commands, "core.x");
    const control = model.tabs()[0]?.groups[0]?.controls[0] as RibbonControl;
    expect(model.controlState(control)).toMatchObject({
      enabled: false,
      reason: "unprovided",
    });
  });

  it("未宣言のコマンドを指す項目は、無効で表示し、command.unknown を 1 回だけ報告する", () => {
    const { model, problems } = setup([
      tab("a", {}, [group("g", [btn("core.missing")])]),
    ]);
    const control = model.tabs()[0]?.groups[0]?.controls[0] as RibbonControl;
    expect(model.controlState(control)).toMatchObject({
      enabled: false,
      reason: "unknown",
    });
    model.tabs();
    model.tabs();
    expect(problems.filter((p) => p.code === "command.unknown")).toHaveLength(
      1,
    );
  });

  it("トグルの checked は、when 式で決まる", () => {
    const { model, ctx, commands } = setup([
      tab("a", {}, [
        group("g", [{ kind: "toggle", command: "core.t", checked: "on" }]),
      ]),
    ]);
    decl(commands, "core.t", { run: vi.fn() });
    const control = model.tabs()[0]?.groups[0]?.controls[0] as RibbonControl;
    expect(model.controlState(control).checked).toBe(false);
    ctx.set("on", true);
    expect(model.controlState(control).checked).toBe(true);
  });

  it("run(control) は、コマンドを引数つきで実行する", async () => {
    const { model, commands } = setup([tab("a")]);
    const run = vi.fn();
    decl(commands, "core.t", { run });
    await model.run({ kind: "smallButton", command: "core.t", args: { v: 1 } });
    expect(run).toHaveBeenCalledWith({ v: 1 });
  });

  it("タブは order の順に並ぶ", () => {
    const { model } = setup([
      tab("b", { order: 20 }),
      tab("a", { order: 10 }),
      tab("c", { order: 20 }),
    ]);
    expect(model.tabs().map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});
