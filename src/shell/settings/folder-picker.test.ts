import { describe, expect, it, vi } from "vitest";
import {
  addRecent,
  createNativeFolderPicker,
  createProjectActions,
  type ProjectActionsDeps,
  removeRecent,
} from "./folder-picker";

describe("最近使ったプロジェクト", () => {
  it("新しい順で、重複を除き、最大 10 件", () => {
    let list: string[] = [];
    for (let i = 0; i < 12; i++) list = addRecent(list, `/p${i}`);
    expect(list).toHaveLength(10);
    expect(list[0]).toBe("/p11");
    expect(list).not.toContain("/p0");
    expect(addRecent(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
  });

  it("空の文字列は入れない", () => {
    expect(addRecent(["/a"], "")).toEqual(["/a"]);
  });

  it("removeRecent で一覧から外す", () => {
    expect(removeRecent(["/a", "/b"], "/a")).toEqual(["/b"]);
    expect(removeRecent(["/a"], "/zzz")).toEqual(["/a"]);
  });
});

function setup(overrides: Partial<ProjectActionsDeps> = {}) {
  const state = {
    recents: ["/old"],
    open: false,
    dirty: false,
    name: null as string | null,
  };
  const notify = vi.fn();
  const deps: ProjectActionsDeps = {
    pick: vi.fn(async () => "/chosen/proj"),
    open: vi.fn(async () => ({ kind: "opened" as const })),
    restore: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ask: vi.fn(async () => "cancel" as const),
    save: vi.fn(async () => {}),
    undo: vi.fn(async () => {}),
    redo: vi.fn(async () => {}),
    getRecents: () => state.recents,
    setRecents: (list) => {
      state.recents = list;
    },
    isOpen: () => state.open,
    isDirty: () => state.dirty,
    onOpened: (folder) => {
      state.open = true;
      state.name = folder;
    },
    notify,
    ...overrides,
  };
  return { deps, state, notify, actions: createProjectActions(deps) };
}

describe("プロジェクトの操作", () => {
  it("フォルダを開く: 選んだフォルダを開き、最近の一覧の先頭に入れる", async () => {
    const { actions, state, deps } = setup();
    await actions.openFolder();
    expect(deps.open).toHaveBeenCalledWith("/chosen/proj", false);
    expect(state.recents).toEqual(["/chosen/proj", "/old"]);
    expect(state.open).toBe(true);
  });

  it("選択を取り消したら、何もしない", async () => {
    const { actions, deps, state } = setup({ pick: vi.fn(async () => null) });
    await actions.openFolder();
    expect(deps.open).not.toHaveBeenCalled();
    expect(state.recents).toEqual(["/old"]);
  });

  it("空・空白だけのパスは、開かずに通知する", async () => {
    const { actions, deps, notify } = setup({ pick: vi.fn(async () => "   ") });
    await actions.openFolder();
    expect(deps.open).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("error", expect.any(String));
  });

  it("新規プロジェクトは、create を真にして開く", async () => {
    const { actions, deps } = setup();
    await actions.createNew();
    expect(deps.open).toHaveBeenCalledWith("/chosen/proj", true);
  });

  it("開けなかったとき: エラーを通知し、最近の一覧から外す", async () => {
    const { actions, state, notify } = setup({
      open: vi.fn(async () => {
        throw new Error("not found");
      }),
    });
    await actions.openRecent("/old");
    expect(notify).toHaveBeenCalledWith("error", expect.any(String));
    expect(state.recents).toEqual([]);
    expect(state.open).toBe(false);
  });

  it("前回の作業用データが残っているときは、復元してから開いた扱いにする", async () => {
    const { actions, deps, state } = setup({
      open: vi.fn(async () => ({ kind: "recovery_available" as const })),
    });
    await actions.openFolder();
    expect(deps.restore).toHaveBeenCalledTimes(1);
    expect(state.open).toBe(true);
  });

  describe("未保存のまま別のプロジェクトを開くとき", () => {
    const dirtyOpen = {
      isOpen: () => true,
      isDirty: () => true,
    };

    it("確認を出し、キャンセルなら何も変えない", async () => {
      const { actions, deps } = setup({
        ...dirtyOpen,
        ask: vi.fn(async () => "cancel" as const),
      });
      await actions.openFolder();
      expect(deps.ask).toHaveBeenCalledTimes(1);
      expect(deps.close).not.toHaveBeenCalled();
      expect(deps.open).not.toHaveBeenCalled();
    });

    it("保存を選ぶと、保存して閉じてから開く", async () => {
      const order: string[] = [];
      const { actions } = setup({
        ...dirtyOpen,
        ask: vi.fn(async () => "save" as const),
        close: vi.fn(async (action) => {
          order.push(`close:${action}`);
        }),
        open: vi.fn(async () => {
          order.push("open");
          return { kind: "opened" as const };
        }),
      });
      await actions.openFolder();
      expect(order).toEqual(["close:save", "open"]);
    });

    it("保存せずに開くを選ぶと、変更を捨てて閉じてから開く", async () => {
      const order: string[] = [];
      const { actions } = setup({
        ...dirtyOpen,
        ask: vi.fn(async () => "discard" as const),
        close: vi.fn(async (action) => {
          order.push(`close:${action}`);
        }),
        open: vi.fn(async () => {
          order.push("open");
          return { kind: "opened" as const };
        }),
      });
      await actions.openFolder();
      expect(order).toEqual(["close:discard", "open"]);
    });

    it("保存に失敗したら、開かずに失敗を知らせる", async () => {
      const { actions, deps, notify } = setup({
        ...dirtyOpen,
        ask: vi.fn(async () => "save" as const),
        close: vi.fn(async () => {
          throw new Error("disk full");
        }),
      });
      await actions.openFolder();
      expect(deps.open).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("disk full"),
      );
    });
  });

  it("開いているプロジェクトが未保存でなければ、閉じてから開く", async () => {
    const order: string[] = [];
    const { actions } = setup({
      isOpen: () => true,
      isDirty: () => false,
      close: vi.fn(async () => {
        order.push("close");
      }),
      open: vi.fn(async () => {
        order.push("open");
        return { kind: "opened" as const };
      }),
    });
    await actions.openFolder();
    expect(order).toEqual(["close", "open"]);
  });

  it("保存・元に戻す・やり直しは、失敗しても例外を外に出さず通知する", async () => {
    const { actions, notify } = setup({
      save: vi.fn(async () => {
        throw new Error("disk full");
      }),
      undo: vi.fn(async () => {
        throw new Error("x");
      }),
    });
    await expect(actions.save()).resolves.toBeUndefined();
    await expect(actions.undo()).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe("OS 標準のフォルダ選択（createNativeFolderPicker）", () => {
  it("OS のダイアログで選んだフォルダを返し、タイトルとフォルダ選択を指定する", async () => {
    const openDialog = vi.fn().mockResolvedValue("/data/p");
    const fallback = { pick: vi.fn() };
    const picker = createNativeFolderPicker(openDialog, fallback);
    expect(await picker.pick({ title: "開く" })).toBe("/data/p");
    expect(openDialog).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "開く",
      canCreateDirectories: true,
    });
    expect(fallback.pick).not.toHaveBeenCalled();
  });

  it("キャンセルは null（簡易ダイアログには切り替えない）", async () => {
    const openDialog = vi.fn().mockResolvedValue(null);
    const fallback = { pick: vi.fn() };
    const picker = createNativeFolderPicker(openDialog, fallback);
    expect(await picker.pick({ title: "x" })).toBeNull();
    expect(fallback.pick).not.toHaveBeenCalled();
  });

  it("OS のダイアログが使えない（例外）ときは、簡易ダイアログに切り替える", async () => {
    const openDialog = vi.fn().mockRejectedValue(new Error("no tauri"));
    const fallback = { pick: vi.fn().mockResolvedValue("/typed") };
    const picker = createNativeFolderPicker(openDialog, fallback);
    expect(await picker.pick({ title: "x" })).toBe("/typed");
    expect(fallback.pick).toHaveBeenCalledWith({ title: "x" });
  });
});
