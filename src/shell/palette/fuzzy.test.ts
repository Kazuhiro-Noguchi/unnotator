import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry } from "../commands/registry";
import { makeProblemSink } from "../testing/fakes";
import { createContext } from "../when/context";
import { rank, searchCommands } from "./fuzzy";

const ids = (results: Array<{ id: string }>) => results.map((r) => r.id);

describe("あいまい検索 rank", () => {
  const items = [
    { id: "a", texts: ["Save project"] },
    { id: "b", texts: ["Select all"] },
    { id: "c", texts: ["Open recent project"] },
    { id: "d", texts: ["保存"] },
  ];

  it("空の入力は、全件を元の順で返す", () => {
    expect(ids(rank("", items))).toEqual(["a", "b", "c", "d"]);
    expect(ids(rank("   ", items))).toEqual(["a", "b", "c", "d"]);
  });

  it("部分列で一致し、一致しないものは除く", () => {
    expect(ids(rank("sv", items))).toEqual(["a"]);
    expect(rank("zzz", items)).toEqual([]);
  });

  it("大文字小文字を区別しない", () => {
    expect(ids(rank("SAVE", items))).toContain("a");
    expect(ids(rank("save", items))).toContain("a");
  });

  it("全角・半角などの表記ゆれ（NFKC）をそろえる", () => {
    const list = [{ id: "x", texts: ["ＡＢＣ command"] }];
    expect(ids(rank("abc", list))).toEqual(["x"]);
  });

  it("日本語の表示名でも一致する", () => {
    expect(ids(rank("保存", items))).toEqual(["d"]);
  });

  it("先頭の一致・連続した一致・語頭の一致を優先する", () => {
    const list = [
      { id: "scattered", texts: ["s_a_v_e something"] },
      { id: "mid", texts: ["do save"] },
      { id: "prefix", texts: ["save it"] },
    ];
    expect(ids(rank("save", list))).toEqual(["prefix", "mid", "scattered"]);
  });

  it("複数の文字列（両言語の名前・ID）のどれかで一致すればよい", () => {
    const list = [
      { id: "core.project.save", texts: ["保存", "Save", "core.project.save"] },
    ];
    expect(ids(rank("save", list))).toEqual(["core.project.save"]);
    expect(ids(rank("保存", list))).toEqual(["core.project.save"]);
    expect(ids(rank("project", list))).toEqual(["core.project.save"]);
  });

  it("同じ得点は、元の順を保つ（安定）", () => {
    const list = [
      { id: "1", texts: ["abc"] },
      { id: "2", texts: ["abc"] },
      { id: "3", texts: ["abc"] },
    ];
    expect(ids(rank("abc", list))).toEqual(["1", "2", "3"]);
  });

  it("1,000 件でも、結果が安定して、すばやく返る", () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({
      id: `cmd.${i}`,
      texts: [`コマンド ${i}`, `Command number ${i}`, `cmd.${i}`],
    }));
    const start = performance.now();
    const first = ids(rank("com 99", many));
    const elapsed = performance.now() - start;
    expect(ids(rank("com 99", many))).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });
});

describe("すべての操作に、パレットから届く（SC-002）", () => {
  it("コアのコマンドは、すべてパレットの候補に出る", async () => {
    const { declareCoreCommands, CORE_COMMANDS } = await import(
      "../commands/core-commands"
    );
    const ctx = createContext();
    const { sink } = makeProblemSink();
    const registry = createCommandRegistry({
      ctx,
      report: sink,
      notify: vi.fn(),
    });
    declareCoreCommands(registry);
    const ids = searchCommands(registry, "", "ja").map((e) => e.id);
    expect(ids.sort()).toEqual(CORE_COMMANDS.map((c) => c.id).sort());
    // 日本語・英語どちらの表示名でも、自分の ID が先頭に近い位置で見つかる。
    for (const command of CORE_COMMANDS) {
      expect(
        searchCommands(registry, command.ja, "ja").map((e) => e.id),
      ).toContain(command.id);
      expect(
        searchCommands(registry, command.en, "en").map((e) => e.id),
      ).toContain(command.id);
    }
  });
});

describe("コマンドパレットの検索", () => {
  function setup() {
    const ctx = createContext();
    const { sink } = makeProblemSink();
    const registry = createCommandRegistry({
      ctx,
      report: sink,
      notify: vi.fn(),
    });
    registry.declare({
      id: "core.save",
      title: { ja: "保存", en: "Save" },
      category: { ja: "ファイル", en: "File" },
      source: "core",
      run: vi.fn(),
    });
    registry.declare({
      id: "core.undo",
      title: { ja: "元に戻す", en: "Undo" },
      source: "core",
      enablement: "canUndo",
      run: vi.fn(),
    });
    registry.declare({
      id: "core.later",
      title: { ja: "あとで", en: "Later" },
      source: "core",
    });
    return { ctx, registry };
  }

  it("両言語の表示名で見つかる（表示は現在の言語）", () => {
    const { registry } = setup();
    expect(searchCommands(registry, "save", "ja")[0]?.title).toBe("保存");
    expect(searchCommands(registry, "保存", "en")[0]?.title).toBe("Save");
  });

  it("実行できないコマンドも出し、enabled と理由を持つ", () => {
    const { registry, ctx } = setup();
    const undo = searchCommands(registry, "undo", "en")[0];
    expect(undo).toMatchObject({
      id: "core.undo",
      enabled: false,
      reason: "condition",
    });
    ctx.set("canUndo", true);
    expect(searchCommands(registry, "undo", "en")[0]).toMatchObject({
      enabled: true,
    });
    expect(searchCommands(registry, "later", "en")[0]).toMatchObject({
      enabled: false,
      reason: "unprovided",
    });
  });

  it("同じ得点なら、実行できるものを先にする", () => {
    const { registry } = setup();
    const all = searchCommands(registry, "", "en");
    expect(all.map((e) => e.id)).toEqual([
      "core.save",
      "core.undo",
      "core.later",
    ]);
  });
});
