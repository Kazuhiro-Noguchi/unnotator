import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry } from "../commands/registry";
import { fakeElement, fakeKeyEvent, makeProblemSink } from "../testing/fakes";
import { createContext } from "../when/context";
import {
  handleKeyEvent,
  installKeyDispatcher,
  type KeyEventLike,
} from "./dispatch";
import { isEditableTarget } from "./editable";
import { createKeymap } from "./keymap";

function setup() {
  const ctx = createContext();
  const { sink } = makeProblemSink();
  const commands = createCommandRegistry({
    ctx,
    report: sink,
    notify: vi.fn(),
  });
  const keymap = createKeymap({ ctx, report: sink, platform: "other" });
  const run = vi.fn();
  commands.declare({ id: "core.act", title: { ja: "a" }, source: "core", run });
  commands.declare({
    id: "core.cond",
    title: { ja: "c" },
    source: "core",
    enablement: "projectOpen",
    run: vi.fn(),
  });
  commands.declare({ id: "core.none", title: { ja: "n" }, source: "core" });
  keymap.setLayer("core", "core", [
    { key: "Ctrl+S", command: "core.act" },
    { key: "Ctrl+Shift+P", command: "core.act" },
    { key: "Ctrl+Z", command: "core.act" },
    { key: "Ctrl+A", command: "core.act" },
    { key: "Escape", command: "core.act" },
    { key: "1", command: "core.act" },
    { key: "Ctrl+W", command: "core.cond" },
    { key: "Ctrl+E", command: "core.none" },
  ]);
  const handle = (init: Parameters<typeof fakeKeyEvent>[0]) => {
    const event = fakeKeyEvent(init);
    handleKeyEvent(event as unknown as KeyEventLike, {
      keymap,
      commands,
      isEditable: isEditableTarget,
    });
    return event;
  };
  return { ctx, commands, keymap, run, handle };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("keydown の入口", () => {
  it("入力欄の外では、解決したコマンドを実行して preventDefault する", async () => {
    const { handle, run } = setup();
    const event = handle({ key: "s", ctrlKey: true });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("解決できないキーは、通す（実行も preventDefault もしない）", async () => {
    const { handle, run } = setup();
    const event = handle({ key: "q", ctrlKey: true });
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("IME の変換中（isComposing・keyCode 229）は、何もしない", async () => {
    const { handle, run } = setup();
    const a = handle({ key: "1", isComposing: true });
    const b = handle({ key: "1", keyCode: 229 });
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(a.defaultPrevented).toBe(false);
    expect(b.defaultPrevented).toBe(false);
  });

  it("入力欄では、標準の編集キー（Ctrl+Z・Ctrl+A・単文字）を通す", async () => {
    const { handle, run } = setup();
    const input = fakeElement("input");
    const z = handle({ key: "z", ctrlKey: true, target: input });
    const a = handle({ key: "a", ctrlKey: true, target: input });
    const one = handle({ key: "1", target: input });
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(
      z.defaultPrevented || a.defaultPrevented || one.defaultPrevented,
    ).toBe(false);
  });

  it("入力欄でも、Ctrl+S・Ctrl+Shift+P・Esc は処理する", async () => {
    const { handle, run } = setup();
    const input = fakeElement("textarea");
    handle({ key: "s", ctrlKey: true, target: input });
    handle({ key: "P", ctrlKey: true, shiftKey: true, target: input });
    handle({ key: "Escape", target: input });
    await flush();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("contenteditable も入力欄として扱う", async () => {
    const { handle, run } = setup();
    handle({ key: "1", target: fakeElement("div", true) });
    await flush();
    expect(run).not.toHaveBeenCalled();
  });

  it("条件が偽・処理が無いコマンドは、実行せず、preventDefault もしない", async () => {
    const { handle, ctx } = setup();
    const cond = handle({ key: "w", ctrlKey: true });
    const none = handle({ key: "e", ctrlKey: true });
    await flush();
    expect(cond.defaultPrevented).toBe(false);
    expect(none.defaultPrevented).toBe(false);
    ctx.set("projectOpen", true);
    const again = handle({ key: "w", ctrlKey: true });
    await flush();
    expect(again.defaultPrevented).toBe(true);
  });

  it("ボタンなど、文字を入力しない要素は入力欄ではない", () => {
    expect(isEditableTarget({ tagName: "INPUT", type: "checkbox" })).toBe(
      false,
    );
    expect(isEditableTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("installKeyDispatcher が window の keydown に結び、dispose で外す", async () => {
    const { commands, keymap, run } = setup();
    const added: Array<[string, unknown, unknown]> = [];
    const removed: string[] = [];
    const target = {
      addEventListener: (type: string, fn: unknown, capture: unknown) =>
        added.push([type, fn, capture]),
      removeEventListener: (type: string) => removed.push(type),
    };
    const handle = installKeyDispatcher(target, {
      keymap,
      commands,
      isEditable: isEditableTarget,
    });
    expect(added).toHaveLength(1);
    expect(added[0]?.[0]).toBe("keydown");
    expect(added[0]?.[2]).toBe(true);
    const listener = added[0]?.[1] as (e: unknown) => void;
    listener(fakeKeyEvent({ key: "s", ctrlKey: true }));
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    handle.dispose();
    expect(removed).toEqual(["keydown"]);
  });
});
