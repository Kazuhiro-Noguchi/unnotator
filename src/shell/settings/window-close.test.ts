import { describe, expect, it, vi } from "vitest";
import { createWindowCloseHandler, type WindowCloseDeps } from "./window-close";

function setup(overrides: Partial<WindowCloseDeps> = {}) {
  const deps: WindowCloseDeps = {
    isOpen: () => true,
    isDirty: () => false,
    ask: vi.fn(async () => "cancel" as const),
    closeProject: vi.fn(async () => {}),
    destroyWindow: vi.fn(async () => {}),
    notify: vi.fn(),
    ...overrides,
  };
  return { deps, handle: createWindowCloseHandler(deps) };
}

describe("ウィンドウを閉じる", () => {
  it("プロジェクトが開いていなければ、そのまま閉じる", async () => {
    const { deps, handle } = setup({ isOpen: () => false });
    await handle();
    expect(deps.ask).not.toHaveBeenCalled();
    expect(deps.closeProject).not.toHaveBeenCalled();
    expect(deps.destroyWindow).toHaveBeenCalledTimes(1);
  });

  it("未保存が無ければ、確認せずに正常に閉じる（復元用データを残さない）", async () => {
    const { deps, handle } = setup();
    await handle();
    expect(deps.ask).not.toHaveBeenCalled();
    expect(deps.closeProject).toHaveBeenCalledWith(null);
    expect(deps.destroyWindow).toHaveBeenCalledTimes(1);
  });

  it("未保存があれば確認し、保存を選ぶと保存して閉じる", async () => {
    const { deps, handle } = setup({
      isDirty: () => true,
      ask: vi.fn(async () => "save" as const),
    });
    await handle();
    expect(deps.closeProject).toHaveBeenCalledWith("save");
    expect(deps.destroyWindow).toHaveBeenCalledTimes(1);
  });

  it("破棄を選ぶと、保存せずに閉じる", async () => {
    const { deps, handle } = setup({
      isDirty: () => true,
      ask: vi.fn(async () => "discard" as const),
    });
    await handle();
    expect(deps.closeProject).toHaveBeenCalledWith("discard");
    expect(deps.destroyWindow).toHaveBeenCalledTimes(1);
  });

  it("キャンセルすると、何もせず開いたままにする", async () => {
    const { deps, handle } = setup({ isDirty: () => true });
    await handle();
    expect(deps.closeProject).not.toHaveBeenCalled();
    expect(deps.destroyWindow).not.toHaveBeenCalled();
  });

  it("保存に失敗したら、閉じずに知らせる（データを失わない）", async () => {
    const { deps, handle } = setup({
      isDirty: () => true,
      ask: vi.fn(async () => "save" as const),
      closeProject: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    await handle();
    expect(deps.destroyWindow).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith("error", expect.any(String));
  });

  it("確認の最中にもう一度閉じる要求が来ても、確認を重ねない", async () => {
    let release: (v: "cancel") => void = () => {};
    const ask = vi.fn(
      () => new Promise<"cancel">((resolve) => (release = resolve)),
    );
    const { handle } = setup({ isDirty: () => true, ask });
    const first = handle();
    await handle();
    expect(ask).toHaveBeenCalledTimes(1);
    release("cancel");
    await first;
  });
});
