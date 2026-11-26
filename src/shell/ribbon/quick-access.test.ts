import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry } from "../commands/registry";
import { makeProblemSink } from "../testing/fakes";
import { createContext } from "../when/context";
import { createQuickAccess } from "./quick-access";

function setup(
  initial: string[] = ["core.undo", "core.redo", "core.project.save"],
) {
  const ctx = createContext();
  const { sink } = makeProblemSink();
  const commands = createCommandRegistry({
    ctx,
    report: sink,
    notify: vi.fn(),
  });
  for (const id of [
    "core.undo",
    "core.redo",
    "core.project.save",
    "core.a",
    "core.b",
  ]) {
    commands.declare({ id, title: { ja: id }, source: "core", run: vi.fn() });
  }
  const save = vi.fn();
  const qa = createQuickAccess({ initial, commands, save });
  return { qa, save, commands };
}

describe("クイックアクセス", () => {
  it("既定は、元に戻す・やり直し・保存", () => {
    const { qa } = setup();
    expect(qa.ids()).toEqual(["core.undo", "core.redo", "core.project.save"]);
  });

  it("追加すると末尾に入り、保存される", () => {
    const { qa, save } = setup();
    expect(qa.add("core.a")).toBe(true);
    expect(qa.ids().at(-1)).toBe("core.a");
    expect(save).toHaveBeenLastCalledWith([...qa.ids()]);
  });

  it("重複は追加しない", () => {
    const { qa } = setup();
    expect(qa.add("core.undo")).toBe(false);
    expect(qa.ids()).toHaveLength(3);
  });

  it("最大 20 件まで", () => {
    const { qa } = setup([]);
    for (let i = 0; i < 25; i++) qa.add(`core.c${i}`);
    expect(qa.ids()).toHaveLength(20);
    expect(qa.add("core.over")).toBe(false);
  });

  it("削除できる", () => {
    const { qa, save } = setup();
    qa.remove("core.redo");
    expect(qa.ids()).toEqual(["core.undo", "core.project.save"]);
    expect(save).toHaveBeenCalled();
    expect(qa.has("core.redo")).toBe(false);
  });

  it("コマンドが無くなっても、配列からは消さず、表示だけしない", () => {
    const { qa, commands } = setup(["core.undo", "com.gone/cmd", "core.redo"]);
    expect(qa.ids()).toEqual(["core.undo", "com.gone/cmd", "core.redo"]);
    expect(qa.visible()).toEqual(["core.undo", "core.redo"]);
    commands.declare({
      id: "com.gone/cmd",
      title: { ja: "x" },
      source: "com.gone",
      run: vi.fn(),
    });
    expect(qa.visible()).toEqual(["core.undo", "com.gone/cmd", "core.redo"]);
  });

  it("購読者に変更を知らせる", () => {
    const { qa } = setup();
    const listener = vi.fn();
    const off = qa.subscribe(listener);
    qa.add("core.a");
    qa.remove("core.a");
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    qa.add("core.b");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("setAll で読み込んだ値に差し替える（保存はしない）", () => {
    const { qa, save } = setup();
    qa.setAll(["core.a"]);
    expect(qa.ids()).toEqual(["core.a"]);
    expect(save).not.toHaveBeenCalled();
  });
});
