import { describe, expect, it, vi } from "vitest";
import en from "../../i18n/en.json";
import ja from "../../i18n/ja.json";
import { parseKey } from "../keys/chord";
import { defaultKeybindings } from "../keys/defaults";
import { createKeymap } from "../keys/keymap";
import { makeProblemSink } from "../testing/fakes";
import { createContext } from "../when/context";
import { CORE_COMMANDS, declareCoreCommands } from "./core-commands";
import { createCommandRegistry } from "./registry";

// specs/006-shell-layout/contracts/core-catalog.md の「コマンドとキー」の表。
const EXPECTED_IDS = [
  "core.undo",
  "core.redo",
  "core.project.save",
  "core.project.open",
  "core.project.new",
  "core.project.openRecent",
  "core.project.duplicate",
  "core.project.import",
  "core.project.export",
  "core.app.settings",
  "core.app.about",
  "core.palette.open",
  "core.edit.delete",
  "core.edit.duplicate",
  "core.edit.selectAll",
  "core.edit.deselect",
  "core.edit.copy",
  "core.edit.cut",
  "core.edit.paste",
  "core.select.next",
  "core.select.prev",
  "core.nav.prev",
  "core.nav.next",
  "core.nav.markDoneAndNext",
  "core.nav.nextUnfinished",
  "core.status.markDone",
  "core.status.needsReview",
  ...Array.from({ length: 9 }, (_, i) => `core.label.pick${i + 1}`),
  "core.relation.create",
  "core.group.create",
  "core.group.ungroup",
  "core.view.annotations.toggle",
  "core.view.labelNames.toggle",
  "core.tool.select",
  "core.view.primarySidebar.toggle",
  "core.view.secondarySidebar.toggle",
  "core.view.bottom.toggle",
  "core.view.theme.set",
  "core.view.language.set",
  "core.project.schema",
  "core.project.settings",
  "core.extensions.manage",
  "core.extensions.install",
  "core.extensions.devMode",
  "core.extensions.pythonJobs",
  "core.primarySidebar.show.explorer",
  "core.primarySidebar.show.labels",
  "core.primarySidebar.show.search",
  "core.primarySidebar.show.extensions",
];

// 設計書 3.4 の既定のキー（コマンド → キー）。
const EXPECTED_KEYS: Record<string, string[]> = {
  "core.undo": ["Ctrl+Z"],
  "core.redo": ["Ctrl+Y", "Ctrl+Shift+Z"],
  "core.project.save": ["Ctrl+S"],
  "core.project.open": ["Ctrl+O"],
  "core.edit.delete": ["Delete"],
  "core.edit.duplicate": ["Ctrl+D"],
  "core.edit.selectAll": ["Ctrl+A"],
  "core.edit.deselect": ["Escape"],
  "core.edit.copy": ["Ctrl+C"],
  "core.edit.cut": ["Ctrl+X"],
  "core.edit.paste": ["Ctrl+V"],
  "core.select.next": ["Tab"],
  "core.select.prev": ["Shift+Tab"],
  "core.nav.prev": ["PageUp"],
  "core.nav.next": ["PageDown"],
  "core.nav.markDoneAndNext": ["Ctrl+Enter"],
  "core.nav.nextUnfinished": ["Ctrl+Shift+N"],
  "core.relation.create": ["Ctrl+L"],
  "core.group.create": ["Ctrl+G"],
  "core.view.annotations.toggle": ["Ctrl+H"],
  "core.palette.open": ["Ctrl+Shift+P"],
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [
      `core.label.pick${i + 1}`,
      [`${i + 1}`],
    ]),
  ),
};

describe("コアのコマンドの一覧", () => {
  it("catalog の全コマンド ID が、重複なく宣言されている", () => {
    const ids = CORE_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("ID は core. で始まり、/ を含まない（拡張機能の完全 ID と衝突しない）", () => {
    for (const command of CORE_COMMANDS) {
      expect(command.id).toMatch(/^core\.[A-Za-z0-9.]+$/);
      expect(command.id).not.toContain("/");
    }
  });

  it("すべての表示名が、日英にある", () => {
    for (const command of CORE_COMMANDS) {
      expect(command.ja, command.id).not.toBe("");
      expect(command.en, command.id).not.toBe("");
    }
  });

  it("declareCoreCommands が、全部を宣言し、重複の報告が無い", () => {
    const ctx = createContext();
    const { sink, problems } = makeProblemSink();
    const registry = createCommandRegistry({
      ctx,
      report: sink,
      notify: vi.fn(),
    });
    declareCoreCommands(registry);
    expect(registry.list()).toHaveLength(EXPECTED_IDS.length);
    expect(problems).toEqual([]);
    expect(registry.get("core.undo")?.source).toBe("core");
  });

  it("実装済みでないコマンドは run が無く、無効になる", () => {
    const ctx = createContext();
    const { sink } = makeProblemSink();
    const registry = createCommandRegistry({
      ctx,
      report: sink,
      notify: vi.fn(),
    });
    declareCoreCommands(registry);
    expect(registry.availability("core.edit.copy")()).toEqual({
      enabled: false,
      reason: "unprovided",
    });
  });

  it("元に戻す・やり直し・保存には、実行できる条件がある", () => {
    const byId = new Map(CORE_COMMANDS.map((c) => [c.id, c]));
    expect(byId.get("core.undo")?.enablement).toBe("canUndo");
    expect(byId.get("core.redo")?.enablement).toBe("canRedo");
    expect(byId.get("core.project.save")?.enablement).toBe("projectOpen");
  });
});

describe("コアの既定のキー", () => {
  const raw = defaultKeybindings();

  it("設計書 3.4 の表と一致する", () => {
    const actual: Record<string, string[]> = {};
    for (const binding of raw) {
      actual[binding.command] = [
        ...(actual[binding.command] ?? []),
        binding.key,
      ];
    }
    for (const [command, keys] of Object.entries(EXPECTED_KEYS)) {
      expect(actual[command]?.sort(), command).toEqual([...keys].sort());
    }
    for (const command of Object.keys(actual)) {
      expect(EXPECTED_KEYS, command).toHaveProperty(command);
    }
  });

  it("すべて解釈できて、衝突が無い", () => {
    const ctx = createContext();
    const { sink, problems } = makeProblemSink();
    const keymap = createKeymap({ ctx, report: sink, platform: "other" });
    keymap.setLayer("core", "core", raw);
    expect(problems).toEqual([]);
    expect(keymap.conflicts()).toEqual([]);
    for (const binding of raw)
      expect(parseKey(binding.key, "other"), binding.key).not.toBeNull();
  });

  it("macOS では、Ctrl が Cmd に読み替わる", () => {
    const ctx = createContext();
    const { sink } = makeProblemSink();
    const keymap = createKeymap({ ctx, report: sink, platform: "mac" });
    keymap.setLayer("core", "core", raw);
    const save = keymap.bindingsFor("core.project.save")[0];
    expect(save?.chord).toMatchObject({ meta: true, ctrl: false, key: "s" });
  });

  it("1〜9・Tab・Shift+Tab・Delete・Esc・PageUp・PageDown は、入力欄の外でだけ有効", () => {
    const limited = [
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "Tab",
      "Shift+Tab",
      "Delete",
      "Escape",
      "PageUp",
      "PageDown",
    ];
    for (const key of limited) {
      const binding = raw.find((b) => b.key === key);
      expect(binding?.when, key).toBe("!inputFocus");
    }
  });

  it("コアに、単文字キー（A / D / R など）を割り当てていない", () => {
    for (const binding of raw) {
      const parts = binding.key.split("+");
      const key = parts[parts.length - 1] ?? "";
      const hasModifier = parts.length > 1;
      if (/^[A-Za-z]$/.test(key)) expect(hasModifier, binding.key).toBe(true);
    }
  });

  it("コマンドの表示名の鍵が、日英にそろっている", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });
});
