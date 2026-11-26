import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry } from "./commands/registry";
import { applyContributions, removeContributions } from "./contributions";
import { chordFromEvent } from "./keys/chord";
import { createKeymap } from "./keys/keymap";
import { createRibbonModel } from "./ribbon/model";
import { createStatusStore } from "./status/store";
import { makeProblemSink } from "./testing/fakes";
import { createContext } from "./when/context";

function setup() {
  const ctx = createContext();
  const { sink, problems } = makeProblemSink();
  const commands = createCommandRegistry({
    ctx,
    report: sink,
    notify: vi.fn(),
  });
  const keymap = createKeymap({ ctx, report: sink, platform: "other" });
  const ribbon = createRibbonModel({ core: [], ctx, commands, report: sink });
  const deps = { ctx, commands, keymap, ribbon };
  return { ctx, commands, keymap, ribbon, problems, deps };
}

const press = (key: string) =>
  chordFromEvent({
    key,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  });

describe("contributes の振り分け", () => {
  it("コマンドを、拡張機能の ID で名前空間化して宣言する（処理は 009 が結ぶ）", () => {
    const { deps, commands } = setup();
    applyContributions(deps, "com.x", {
      commands: [
        {
          id: "draw",
          title: "Draw",
          category: "Shapes",
          icon: "icons/draw.svg",
          enablement: "projectOpen",
        },
      ],
    });
    const spec = commands.get("com.x/draw");
    expect(spec).toMatchObject({
      id: "com.x/draw",
      source: "com.x",
      icon: "icons/draw.svg",
      enablement: "projectOpen",
    });
    expect(spec?.title).toEqual({ ja: "Draw", en: "Draw" });
    expect(commands.availability("com.x/draw")()).toEqual({
      enabled: false,
      reason: "unprovided",
    });
  });

  it("既に完全な ID なら、そのまま使う", () => {
    const { deps, commands } = setup();
    applyContributions(deps, "com.x", {
      commands: [{ id: "com.x/draw", title: "Draw" }],
    });
    expect(commands.get("com.x/draw")).toBeDefined();
  });

  it("キー割り当てを、拡張機能の層に登録する", () => {
    const { deps, keymap } = setup();
    applyContributions(deps, "com.x", {
      keybindings: [
        { key: "Ctrl+K", command: "com.x/draw", when: "projectOpen" },
      ],
    });
    expect(keymap.resolve(press("k"))).toBeNull();
    deps.ctx.set("projectOpen", true);
    expect(keymap.resolve(press("k"))).toEqual({ command: "com.x/draw" });
    expect(keymap.bindingsFor("com.x/draw")[0]?.tier).toBe("extension");
  });

  it("リボンの寄与を、リボンのモデルに渡す", () => {
    const { deps, ribbon } = setup();
    applyContributions(deps, "com.x", {
      ribbon: {
        tabs: [
          {
            id: "t",
            title: "T",
            groups: [
              {
                id: "g",
                title: "G",
                items: [{ type: "smallButton", command: "com.x/draw" }],
              },
            ],
          },
        ],
      },
    });
    expect(ribbon.tabs().map((t) => t.id)).toEqual(["com.x/t"]);
  });

  it("removeContributions で、コマンド・キー・リボン・コンテキストが全部外れる", () => {
    const { deps, commands, keymap, ribbon, ctx } = setup();
    applyContributions(deps, "com.x", {
      commands: [{ id: "draw", title: "Draw" }],
      keybindings: [{ key: "Ctrl+K", command: "com.x/draw" }],
      ribbon: {
        tabs: [
          {
            id: "t",
            title: "T",
            groups: [
              {
                id: "g",
                title: "G",
                items: [{ type: "smallButton", command: "com.x/draw" }],
              },
            ],
          },
        ],
      },
    });
    ctx.setNamespaced("com.x", "selection", "a");
    removeContributions(deps, "com.x");
    expect(commands.get("com.x/draw")).toBeUndefined();
    expect(keymap.resolve(press("k"))).toBeNull();
    expect(ribbon.tabs()).toEqual([]);
    expect(ctx.get("com.x.selection")).toBeNull();
  });

  it("もう一度 applyContributions すると、前の内容を置き換える（二重に登録されない）", () => {
    const { deps, commands } = setup();
    applyContributions(deps, "com.x", { commands: [{ id: "a", title: "A" }] });
    applyContributions(deps, "com.x", { commands: [{ id: "b", title: "B" }] });
    expect(commands.list().map((c) => c.id)).toEqual(["com.x/b"]);
  });

  it("壊れた寄与 1 件が、他を止めない", () => {
    const { deps, commands, problems } = setup();
    applyContributions(deps, "com.x", {
      commands: [
        { id: "ok", title: "OK" },
        { id: "", title: "bad" } as never,
        null as never,
      ],
      keybindings: [{ key: "Bogus+K", command: "com.x/ok" }],
    });
    expect(commands.get("com.x/ok")).toBeDefined();
    expect(problems.length).toBeGreaterThan(0);
  });

  it("removeContributions で、拡張機能が出したステータスバーの項目も外れる", () => {
    const { deps } = setup();
    const status = createStatusStore();
    const key = { source: "com.x", id: "pos" };
    status.setItem({ ...key, alignment: "right", priority: 0, text: "x" }, key);
    status.setItem(
      { source: "core", id: "a", alignment: "right", priority: 0, text: "c" },
      { source: "core", id: "a" },
    );
    removeContributions({ ...deps, status }, "com.x");
    expect(status.items("right").map((i) => i.text)).toEqual(["c"]);
  });

  it("他の拡張機能の寄与には触れない", () => {
    const { deps, commands } = setup();
    applyContributions(deps, "com.x", { commands: [{ id: "a", title: "A" }] });
    applyContributions(deps, "com.y", { commands: [{ id: "a", title: "A" }] });
    removeContributions(deps, "com.x");
    expect(commands.list().map((c) => c.id)).toEqual(["com.y/a"]);
  });
});
