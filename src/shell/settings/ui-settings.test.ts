import { describe, expect, it, vi } from "vitest";
import { FakeUserSettings, makeProblemSink } from "../testing/fakes";
import {
  createUiSettingsWriter,
  DEFAULT_QUICK_ACCESS,
  loadUiSettings,
} from "./ui-settings";

function portOf(fake: FakeUserSettings) {
  return {
    readUserLayer: async () =>
      JSON.parse(await fake.layer()) as Record<string, unknown>,
    write: (key: string, value: unknown) =>
      fake.set(key, JSON.stringify(value)),
  };
}

describe("ui-settings: 読み込み", () => {
  it("何も無ければ既定値", async () => {
    const { sink, problems } = makeProblemSink();
    const s = await loadUiSettings(portOf(new FakeUserSettings()), sink);
    expect(s.theme).toBe("system");
    expect(s.language).toBe("system");
    expect(s.layout).toBeUndefined();
    expect(s.quickAccess).toEqual(DEFAULT_QUICK_ACCESS);
    expect(s.keybindings).toEqual([]);
    expect(s.recentProjects).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("有効な値はそのまま読む", async () => {
    const fake = new FakeUserSettings({
      "ui.theme": "dark",
      "ui.language": "en",
      "ui.layout": { version: 1 },
      "ui.quickAccess": ["core.undo"],
      "ui.keybindings": [{ key: "a", command: "x" }],
      "ui.recentProjects": ["/a", "/b"],
    });
    const { sink, problems } = makeProblemSink();
    const s = await loadUiSettings(portOf(fake), sink);
    expect(s.theme).toBe("dark");
    expect(s.language).toBe("en");
    expect(s.layout).toEqual({ version: 1 });
    expect(s.quickAccess).toEqual(["core.undo"]);
    expect(s.keybindings).toHaveLength(1);
    expect(s.recentProjects).toEqual(["/a", "/b"]);
    expect(problems).toEqual([]);
  });

  it("不正な値は既定に戻り、settings.invalid を報告する", async () => {
    const fake = new FakeUserSettings({
      "ui.theme": "purple",
      "ui.language": 3,
      "ui.quickAccess": "core.undo",
      "ui.keybindings": { a: 1 },
      "ui.recentProjects": [1, 2],
    });
    const { sink, problems } = makeProblemSink();
    const s = await loadUiSettings(portOf(fake), sink);
    expect(s.theme).toBe("system");
    expect(s.language).toBe("system");
    expect(s.quickAccess).toEqual(DEFAULT_QUICK_ACCESS);
    expect(s.keybindings).toEqual([]);
    expect(s.recentProjects).toEqual([]);
    expect(problems.filter((p) => p.code === "settings.invalid")).toHaveLength(
      5,
    );
  });

  it("quickAccess の重複を除き、最大 20 件にする", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `core.c${i}`);
    const fake = new FakeUserSettings({
      "ui.quickAccess": ["core.undo", "core.undo", ...many],
    });
    const { sink } = makeProblemSink();
    const s = await loadUiSettings(portOf(fake), sink);
    expect(s.quickAccess).toHaveLength(20);
    expect(new Set(s.quickAccess).size).toBe(20);
    expect(s.quickAccess[0]).toBe("core.undo");
  });

  it("recentProjects の空文字・重複を除き、最大 10 件にする", async () => {
    const many = Array.from({ length: 15 }, (_, i) => `/p${i}`);
    const fake = new FakeUserSettings({
      "ui.recentProjects": ["", "/p0", ...many],
    });
    const { sink } = makeProblemSink();
    const s = await loadUiSettings(portOf(fake), sink);
    expect(s.recentProjects).toHaveLength(10);
    expect(s.recentProjects).not.toContain("");
    expect(new Set(s.recentProjects).size).toBe(10);
  });

  it("読み込みに失敗しても、既定で起動する", async () => {
    const fake = new FakeUserSettings();
    fake.failLayer = true;
    const { sink, problems } = makeProblemSink();
    const s = await loadUiSettings(portOf(fake), sink);
    expect(s.theme).toBe("system");
    expect(problems.map((p) => p.code)).toEqual(["settings.invalid"]);
  });
});

describe("ui-settings: 保存", () => {
  it("300 ミリ秒でまとめ、同じキーは最後の値だけ書く", async () => {
    vi.useFakeTimers();
    const fake = new FakeUserSettings();
    const { sink } = makeProblemSink();
    const writer = createUiSettingsWriter(portOf(fake), sink, vi.fn());
    writer.save("ui.layout", { n: 1 });
    writer.save("ui.layout", { n: 2 });
    writer.save("ui.layout", { n: 3 });
    writer.save("ui.theme", "dark");
    expect(fake.setCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(299);
    expect(fake.setCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(fake.setCalls.map((c) => c.key).sort()).toEqual([
      "ui.layout",
      "ui.theme",
    ]);
    expect(fake.values["ui.layout"]).toEqual({ n: 3 });
    vi.useRealTimers();
  });

  it("flush で、待たずに書く", async () => {
    const fake = new FakeUserSettings();
    const { sink } = makeProblemSink();
    const writer = createUiSettingsWriter(portOf(fake), sink, vi.fn());
    writer.save("ui.theme", "light");
    await writer.flush();
    expect(fake.values["ui.theme"]).toBe("light");
  });

  it("保存の失敗は、通知と問題になり、例外を外に出さない", async () => {
    const fake = new FakeUserSettings();
    fake.failSet = true;
    const { sink, problems } = makeProblemSink();
    const notify = vi.fn();
    const writer = createUiSettingsWriter(portOf(fake), sink, notify);
    writer.save("ui.theme", "dark");
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith("error", expect.any(String));
    expect(problems.map((p) => p.code)).toEqual(["settings.invalid"]);
  });
});
