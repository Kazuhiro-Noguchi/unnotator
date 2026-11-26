import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry } from "../commands/registry";
import { makeProblemSink } from "../testing/fakes";
import type { RibbonTab } from "../types";
import { createContext } from "../when/context";
import { chooseFallbackTab } from "./contributions";
import { createRibbonModel } from "./model";

const group = (id: string, ids: string[]) => ({
  id,
  title: { ja: id },
  priority: 0,
  source: "core",
  controls: ids.map((command) => ({ kind: "smallButton" as const, command })),
});
const core: RibbonTab[] = [
  {
    id: "home",
    title: { ja: "ホーム" },
    order: 10,
    contextual: false,
    source: "core",
    groups: [group("home.tools", ["core.tool.select"])],
  },
  {
    id: "view",
    title: { ja: "表示" },
    order: 20,
    contextual: false,
    source: "core",
    groups: [group("view.panels", ["core.a"])],
  },
];

function setup() {
  const ctx = createContext();
  const { sink, problems } = makeProblemSink();
  const commands = createCommandRegistry({
    ctx,
    report: sink,
    notify: vi.fn(),
  });
  for (const id of [
    "core.tool.select",
    "core.a",
    "com.x/draw",
    "com.x/other",
    "com.y/z",
  ]) {
    commands.declare({
      id,
      title: { ja: id },
      source: id.startsWith("core") ? "core" : (id.split("/")[0] ?? "x"),
      run: vi.fn(),
    });
  }
  const model = createRibbonModel({ core, ctx, commands, report: sink });
  return { ctx, model, problems };
}

const item = (command: string) => ({ type: "smallButton" as const, command });

describe("拡張機能の寄与（リボン）", () => {
  it("新しいタブを足せる。ID は拡張機能の ID で名前空間化される", () => {
    const { model } = setup();
    model.addContribution("com.x", {
      tabs: [
        {
          id: "draw",
          title: "Draw",
          groups: [
            { id: "tools", title: "Tools", items: [item("com.x/draw")] },
          ],
        },
      ],
    });
    const tabs = model.tabs();
    const added = tabs.find((t) => t.id === "com.x/draw");
    expect(added).toBeDefined();
    expect(added?.source).toBe("com.x");
    expect(added?.contextual).toBe(false);
    expect(added?.groups[0]?.id).toBe("com.x/tools");
    expect(added?.groups[0]?.controls[0]).toMatchObject({
      kind: "smallButton",
      command: "com.x/draw",
    });
  });

  it("既存のコアのタブに、新しいグループを足せる", () => {
    const { model } = setup();
    model.addContribution("com.x", {
      groups: [
        {
          tab: "home",
          id: "extra",
          title: "Extra",
          items: [item("com.x/draw")],
        },
      ],
    });
    const home = model.tabs().find((t) => t.id === "home");
    expect(home?.groups.map((g) => g.id)).toEqual([
      "home.tools",
      "com.x/extra",
    ]);
  });

  it("既存のグループに、項目だけを足せる（コアの ID は上書きされない）", () => {
    const { model } = setup();
    model.addContribution("com.x", {
      groups: [
        { tab: "home", group: "home.tools", items: [item("com.x/draw")] },
      ],
    });
    const tools = model
      .tabs()
      .find((t) => t.id === "home")
      ?.groups.find((g) => g.id === "home.tools");
    expect(tools?.controls.map((c) => c.command)).toEqual([
      "core.tool.select",
      "com.x/draw",
    ]);
    expect(tools?.source).toBe("core");
  });

  it("同じ ID のタブを足しても、コアのタブは置き換わらない", () => {
    const { model } = setup();
    model.addContribution("com.x", {
      tabs: [
        {
          id: "home",
          title: "Fake",
          groups: [{ id: "g", title: "G", items: [item("com.x/draw")] }],
        },
      ],
    });
    const ids = model.tabs().map((t) => t.id);
    expect(ids.filter((id) => id === "home")).toHaveLength(1);
    expect(model.tabs().find((t) => t.id === "home")?.title).toEqual({
      ja: "ホーム",
    });
    expect(ids).toContain("com.x/home");
  });

  it("存在しないタブ・グループを指す寄与は、ribbon.target-missing を報告して捨てる", () => {
    const { model, problems } = setup();
    model.addContribution("com.x", {
      groups: [
        { tab: "nope", id: "g", title: "G", items: [item("com.x/draw")] },
        { tab: "home", group: "home.nope", items: [item("com.x/draw")] },
      ],
    });
    model.tabs();
    expect(
      problems.filter((p) => p.code === "ribbon.target-missing"),
    ).toHaveLength(2);
    const home = model.tabs().find((t) => t.id === "home");
    expect(home?.groups.map((g) => g.id)).toEqual(["home.tools"]);
  });

  it("他の拡張機能のタブに、後から足せる（登録の順に依らない）", () => {
    const { model } = setup();
    model.addContribution("com.y", {
      groups: [
        {
          tab: "com.x/draw",
          id: "more",
          title: "More",
          items: [item("com.y/z")],
        },
      ],
    });
    model.addContribution("com.x", {
      tabs: [
        {
          id: "draw",
          title: "Draw",
          groups: [{ id: "tools", title: "T", items: [item("com.x/draw")] }],
        },
      ],
    });
    const tab = model.tabs().find((t) => t.id === "com.x/draw");
    expect(tab?.groups.map((g) => g.id)).toEqual(["com.x/tools", "com.y/more"]);
  });

  it("コンテキストタブは、when が真のときだけ出て、偽になると消える", () => {
    const { model, ctx } = setup();
    model.addContribution("com.x", {
      contextualTabs: [
        {
          id: "rect",
          title: "Rect",
          when: "activeEditor == 'a' && selection.type == 'b'",
          groups: [{ id: "g", title: "G", items: [item("com.x/draw")] }],
        },
      ],
    });
    const has = () => model.tabs().some((t) => t.id === "com.x/rect");
    expect(has()).toBe(false);
    ctx.set("activeEditor", "a");
    ctx.set("selection.type", "b");
    expect(has()).toBe(true);
    expect(model.tabs().find((t) => t.id === "com.x/rect")?.contextual).toBe(
      true,
    );
    ctx.set("selection.type", "c");
    expect(has()).toBe(false);
  });

  it("コンテキストタブは、通常のタブの後ろに並ぶ", () => {
    const { model, ctx } = setup();
    ctx.set("on", true);
    model.addContribution("com.x", {
      contextualTabs: [
        {
          id: "c",
          title: "C",
          when: "on",
          groups: [{ id: "g", title: "G", items: [item("com.x/draw")] }],
        },
      ],
      tabs: [
        {
          id: "t",
          title: "T",
          groups: [{ id: "g", title: "G", items: [item("com.x/draw")] }],
        },
      ],
    });
    const ids = model.tabs().map((t) => t.id);
    expect(ids.indexOf("com.x/c")).toBe(ids.length - 1);
  });

  it("Disposable で、その拡張機能の寄与がすべて消える", () => {
    const { model } = setup();
    const handle = model.addContribution("com.x", {
      tabs: [
        {
          id: "draw",
          title: "D",
          groups: [{ id: "g", title: "G", items: [item("com.x/draw")] }],
        },
      ],
      groups: [
        { tab: "home", id: "extra", title: "E", items: [item("com.x/draw")] },
      ],
    });
    handle.dispose();
    expect(model.tabs().map((t) => t.id)).toEqual(["home", "view"]);
    expect(model.tabs()[0]?.groups.map((g) => g.id)).toEqual(["home.tools"]);
  });

  it("when つきの項目・グループが評価される", () => {
    const { model, ctx } = setup();
    model.addContribution("com.x", {
      groups: [
        {
          tab: "home",
          id: "g",
          title: "G",
          when: "flag",
          items: [
            { type: "smallButton", command: "com.x/draw", when: "flag2" },
          ],
        },
      ],
    });
    const home = () => model.tabs().find((t) => t.id === "home");
    expect(home()?.groups.map((g) => g.id)).toEqual(["home.tools"]);
    ctx.set("flag", true);
    // 見えるコントロールが無いグループは、出ない。
    expect(home()?.groups.map((g) => g.id)).toEqual(["home.tools"]);
    ctx.set("flag2", true);
    expect(home()?.groups.at(-1)?.controls).toHaveLength(1);
  });

  it("分割ボタン・ドロップダウンの items も、種別と名前を変換する", () => {
    const { model } = setup();
    model.addContribution("com.x", {
      tabs: [
        {
          id: "t",
          title: "T",
          groups: [
            {
              id: "g",
              title: "G",
              items: [
                {
                  type: "dropdown",
                  items: [item("com.x/draw"), item("com.x/other")],
                },
              ],
            },
          ],
        },
      ],
    });
    const control = model.tabs().find((t) => t.id === "com.x/t")?.groups[0]
      ?.controls[0];
    expect(control?.kind).toBe("dropdown");
    expect(control?.items?.map((i) => i.command)).toEqual([
      "com.x/draw",
      "com.x/other",
    ]);
  });

  it("変更を ctx.watch で購読できる", () => {
    const { model, ctx } = setup();
    const seen: number[] = [];
    ctx.watch(
      () => model.tabs().length,
      (n) => seen.push(n),
    );
    model.addContribution("com.x", {
      tabs: [
        {
          id: "t",
          title: "T",
          groups: [{ id: "g", title: "G", items: [item("com.x/draw")] }],
        },
      ],
    });
    expect(seen).toEqual([3]);
  });
});

describe("コンテキストタブが消えたときの戻り先", () => {
  const tabs = (ids: string[]) =>
    ids.map((id) => ({ id, contextual: id.startsWith("ctx") }) as RibbonTab);

  it("選択中のタブが残っていれば、そのまま", () => {
    expect(
      chooseFallbackTab(tabs(["file", "home", "ctx1"]), "ctx1", "home"),
    ).toBe("ctx1");
  });

  it("消えたら、直前の通常のタブに戻る", () => {
    expect(
      chooseFallbackTab(tabs(["file", "home", "view"]), "ctx1", "view"),
    ).toBe("view");
  });

  it("直前のタブも無ければ、先頭の通常のタブ（ファイルを除く）", () => {
    expect(
      chooseFallbackTab(tabs(["file", "home", "view"]), "ctx1", "gone"),
    ).toBe("home");
    expect(chooseFallbackTab(tabs(["file", "home"]), "ctx1", null)).toBe(
      "home",
    );
  });

  it("タブが 1 つも無いときは null", () => {
    expect(chooseFallbackTab([], "x", null)).toBeNull();
  });
});
