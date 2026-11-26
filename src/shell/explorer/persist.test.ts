import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExplorerPersist,
  folderKeyFromText,
  folderKeyToText,
  MAX_PROJECTS,
  parsePersisted,
  remember,
} from "./persist";

const key = (root_key: string, path: string) => ({ root_key, path });

describe("フォルダの鍵", () => {
  it("ルートとフォルダを符号化して、元に戻せる", () => {
    expect(folderKeyToText(key("", "a/sub"))).toBe(":a/sub");
    expect(folderKeyFromText(":a/sub")).toEqual(key("", "a/sub"));
    expect(folderKeyFromText(folderKeyToText(key("ext:1", "x:y")))).toEqual(
      key("ext:1", "x:y"),
    );
    expect(folderKeyFromText(folderKeyToText(key("photos", "")))).toEqual(
      key("photos", ""),
    );
  });

  it("区切りの無い文字列は拒む", () => {
    expect(folderKeyFromText("nocolon")).toBeNull();
  });
});

describe("parsePersisted", () => {
  it("形が違えば空に戻す", () => {
    expect(parsePersisted(null)).toEqual({});
    expect(parsePersisted([])).toEqual({});
    expect(parsePersisted("x")).toEqual({});
    expect(parsePersisted(3)).toEqual({});
  });

  it("文字列の配列だけを残す", () => {
    expect(
      parsePersisted({ "/p": [":a", 1, ":b"], "/q": "bad", "/r": [] }),
    ).toEqual({ "/p": [":a", ":b"], "/r": [] });
  });

  it("20 件を超えたら、新しい側（後ろ）の 20 件を残す", () => {
    const many: Record<string, string[]> = {};
    for (let i = 0; i < MAX_PROJECTS + 5; i += 1) many[`/p${i}`] = [":a"];
    const parsed = parsePersisted(many);
    expect(Object.keys(parsed).length).toBe(MAX_PROJECTS);
    expect(Object.keys(parsed)[0]).toBe("/p5");
  });
});

describe("remember", () => {
  it("プロジェクトごとに保存し、最近使ったものを後ろに置く", () => {
    let value = remember({}, "/a", [key("", "x")]);
    value = remember(value, "/b", [key("", "y")]);
    value = remember(value, "/a", [key("", "z")]);
    expect(Object.keys(value)).toEqual(["/b", "/a"]);
    expect(value["/a"]).toEqual([":z"]);
  });

  it("20 件を超えたら、古いものから捨てる", () => {
    let value: Record<string, string[]> = {};
    for (let i = 0; i < MAX_PROJECTS + 3; i += 1) {
      value = remember(value, `/p${i}`, [key("", "a")]);
    }
    expect(Object.keys(value).length).toBe(MAX_PROJECTS);
    expect(value["/p0"]).toBeUndefined();
    expect(value[`/p${MAX_PROJECTS + 2}`]).toBeDefined();
  });

  it("元の値を書き換えない", () => {
    const base = { "/a": [":x"] };
    remember(base, "/a", []);
    expect(base).toEqual({ "/a": [":x"] });
  });
});

describe("ExplorerPersist", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function port(initial: unknown) {
    const writes: unknown[] = [];
    return {
      writes,
      read: async () => initial,
      write: async (value: unknown) => {
        writes.push(value);
      },
    };
  }

  it("プロジェクトのフォルダに対応する開いたフォルダを読む", async () => {
    const p = port({ "/proj": [":a", "photos:p"], "/other": [":z"] });
    const persist = createExplorerPersist(p, "/proj");
    expect(await persist.load()).toEqual([key("", "a"), key("photos", "p")]);
  });

  it("存在しないフォルダは、復元で捨てる", async () => {
    const p = port({ "/proj": [":a", ":gone"] });
    const persist = createExplorerPersist(p, "/proj");
    const keys = await persist.load((k) => k.path !== "gone");
    expect(keys).toEqual([key("", "a")]);
  });

  it("読めない・壊れた値でも、空で始める", async () => {
    const persist = createExplorerPersist(
      {
        read: async () => {
          throw new Error("x");
        },
        write: async () => {},
      },
      "/proj",
    );
    expect(await persist.load()).toEqual([]);
  });

  it("保存は 500 ミリ秒でまとめ、最後の値だけを書く", async () => {
    const p = port({});
    const persist = createExplorerPersist(p, "/proj");
    await persist.load();
    persist.save([key("", "a")]);
    await vi.advanceTimersByTimeAsync(300);
    persist.save([key("", "a"), key("", "b")]);
    await vi.advanceTimersByTimeAsync(499);
    expect(p.writes.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.writes).toEqual([{ "/proj": [":a", ":b"] }]);
  });

  it("flush で、待たずに書く", async () => {
    const p = port({});
    const persist = createExplorerPersist(p, "/proj");
    await persist.load();
    persist.save([key("", "a")]);
    await persist.flush();
    expect(p.writes.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.writes.length).toBe(1);
  });

  it("ほかのプロジェクトの記録を消さない", async () => {
    const p = port({ "/other": [":z"] });
    const persist = createExplorerPersist(p, "/proj");
    await persist.load();
    persist.save([key("", "a")]);
    await persist.flush();
    expect(p.writes[0]).toEqual({ "/other": [":z"], "/proj": [":a"] });
  });

  it("書き込みの失敗は、呼び出し側に例外を出さない", async () => {
    const persist = createExplorerPersist(
      {
        read: async () => ({}),
        write: async () => {
          throw new Error("disk");
        },
      },
      "/proj",
    );
    await persist.load();
    persist.save([key("", "a")]);
    await expect(persist.flush()).resolves.toBeUndefined();
  });
});
