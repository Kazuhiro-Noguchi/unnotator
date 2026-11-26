import { describe, expect, it } from "vitest";
import { FakeEmitter } from "../testing/fakes";
import { createContext } from "../when/context";
import { bindProjectContext, projectName, titleText } from "./project-context";

function setup(
  overrides: { canUndo?: boolean; canRedo?: boolean; dirty?: boolean } = {},
) {
  const ctx = createContext();
  const state = {
    can_undo: overrides.canUndo ?? false,
    can_redo: overrides.canRedo ?? false,
    dirty: overrides.dirty ?? false,
  };
  const stateChanged = new FakeEmitter<{ dirty: boolean }>();
  const projectChanged = new FakeEmitter<undefined>();
  const binding = bindProjectContext({
    ctx,
    undoState: async () => ({
      can_undo: state.can_undo,
      can_redo: state.can_redo,
    }),
    saveState: async () => ({ dirty: state.dirty }),
    onStateChanged: (h) => stateChanged.listen(h),
    onProjectChanged: (h) => projectChanged.listen(() => h()),
  });
  return { ctx, state, stateChanged, projectChanged, binding };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("プロジェクトの状態 → コンテキスト", () => {
  it("開く前は、すべて偽", () => {
    const { ctx } = setup();
    expect(ctx.get("projectOpen")).toBe(false);
    expect(ctx.get("projectDirty")).toBe(false);
    expect(ctx.get("canUndo")).toBe(false);
    expect(ctx.get("canRedo")).toBe(false);
  });

  it("開くと projectOpen が真になり、Undo と未保存の状態を読む", async () => {
    const { ctx, binding } = setup({ canUndo: true, dirty: true });
    await binding.setOpen(true);
    expect(ctx.get("projectOpen")).toBe(true);
    expect(ctx.get("canUndo")).toBe(true);
    expect(ctx.get("canRedo")).toBe(false);
    expect(ctx.get("projectDirty")).toBe(true);
  });

  it("閉じると、すべて偽に戻る", async () => {
    const { ctx, binding } = setup({
      canUndo: true,
      canRedo: true,
      dirty: true,
    });
    await binding.setOpen(true);
    await binding.setOpen(false);
    expect(ctx.get("projectOpen")).toBe(false);
    expect(ctx.get("projectDirty")).toBe(false);
    expect(ctx.get("canUndo")).toBe(false);
    expect(ctx.get("canRedo")).toBe(false);
  });

  it("project-state-changed で projectDirty が変わり、Undo の状態を読み直す", async () => {
    const { ctx, binding, state, stateChanged } = setup();
    await binding.setOpen(true);
    state.can_undo = true;
    stateChanged.emit({ dirty: true });
    await flush();
    expect(ctx.get("projectDirty")).toBe(true);
    expect(ctx.get("canUndo")).toBe(true);
    state.can_undo = false;
    state.can_redo = true;
    stateChanged.emit({ dirty: false });
    await flush();
    expect(ctx.get("projectDirty")).toBe(false);
    expect(ctx.get("canUndo")).toBe(false);
    expect(ctx.get("canRedo")).toBe(true);
  });

  it("project-changed で Undo の状態を読み直す", async () => {
    const { ctx, binding, state, projectChanged } = setup();
    await binding.setOpen(true);
    state.can_undo = true;
    projectChanged.emit(undefined);
    await flush();
    expect(ctx.get("canUndo")).toBe(true);
  });

  it("開いていないときのイベントは無視する", async () => {
    const { ctx, state, stateChanged } = setup();
    state.can_undo = true;
    stateChanged.emit({ dirty: true });
    await flush();
    expect(ctx.get("projectDirty")).toBe(false);
    expect(ctx.get("canUndo")).toBe(false);
  });

  it("dispose で購読を外す", () => {
    const { binding, stateChanged, projectChanged } = setup();
    expect(stateChanged.size).toBe(1);
    binding.dispose();
    expect(stateChanged.size).toBe(0);
    expect(projectChanged.size).toBe(0);
  });
});

describe("タイトル", () => {
  it("プロジェクトが無いときは、アプリ名だけ", () => {
    expect(titleText(null, false)).toBe("unnotator");
  });

  it("プロジェクト名があれば、名前とアプリ名", () => {
    expect(titleText("sample", false)).toBe("sample — unnotator");
  });

  it("未保存のときだけ ● が付く", () => {
    expect(titleText("sample", true)).toBe("● sample — unnotator");
    expect(titleText("sample", false)).not.toContain("●");
  });

  it("フォルダのパスから、最後の名前を取る（区切りは / と \\ の両方）", () => {
    expect(projectName("/home/a/proj")).toBe("proj");
    expect(projectName("C:\\Users\\a\\proj\\")).toBe("proj");
    expect(projectName("/")).toBe("/");
    expect(projectName("")).toBe("");
  });
});
