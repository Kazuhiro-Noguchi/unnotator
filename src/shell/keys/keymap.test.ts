import { describe, expect, it, vi } from "vitest";
import { makeProblemSink } from "../testing/fakes";
import { createContext } from "../when/context";
import { chordFromEvent, parseKey } from "./chord";
import { createKeymap } from "./keymap";

function setup(platform: "mac" | "other" = "other") {
  const ctx = createContext();
  const { sink, problems } = makeProblemSink();
  const keymap = createKeymap({ ctx, report: sink, platform });
  const chord = (text: string) => parseKey(text, platform) as never;
  return { ctx, keymap, problems, chord };
}

describe("キーマップの解決", () => {
  it("宣言したキーから、コマンドを解決する", () => {
    const { keymap, chord } = setup();
    keymap.setLayer("core", "core", [{ key: "Ctrl+S", command: "core.save" }]);
    expect(keymap.resolve(chord("Ctrl+S"))).toEqual({ command: "core.save" });
    expect(keymap.resolve(chord("Ctrl+Q"))).toBeNull();
  });

  it("引数を渡す", () => {
    const { keymap, chord } = setup();
    keymap.setLayer("core", "core", [
      { key: "1", command: "core.pick", args: { n: 1 } },
    ]);
    expect(keymap.resolve(chord("1"))).toEqual({
      command: "core.pick",
      args: { n: 1 },
    });
  });

  it("when が真のものだけが候補になる", () => {
    const { keymap, ctx, chord } = setup();
    keymap.setLayer("core", "core", [
      { key: "A", command: "x", when: "mode == 'a'" },
    ]);
    expect(keymap.resolve(chord("A"))).toBeNull();
    ctx.set("mode", "a");
    expect(keymap.resolve(chord("A"))).toEqual({ command: "x" });
  });

  it("層の優先: 利用者 > 拡張機能 > コア", () => {
    const { keymap, chord } = setup();
    keymap.setLayer("core", "core", [{ key: "Ctrl+K", command: "core.k" }]);
    keymap.setLayer("extension", "com.x", [
      { key: "Ctrl+K", command: "com.x/k" },
    ]);
    expect(keymap.resolve(chord("Ctrl+K"))?.command).toBe("com.x/k");
    keymap.setLayer("user", "user", [{ key: "Ctrl+K", command: "user.k" }]);
    expect(keymap.resolve(chord("Ctrl+K"))?.command).toBe("user.k");
  });

  it("同じ層では、後の宣言が勝つ", () => {
    const { keymap, chord } = setup();
    keymap.setLayer("user", "user", [
      { key: "Ctrl+K", command: "first" },
      { key: "Ctrl+K", command: "second" },
    ]);
    expect(keymap.resolve(chord("Ctrl+K"))?.command).toBe("second");
  });

  it("上の層の when が偽なら、下の層が使われる", () => {
    const { keymap, ctx, chord } = setup();
    keymap.setLayer("core", "core", [{ key: "A", command: "core.a" }]);
    keymap.setLayer("extension", "com.x", [
      { key: "A", command: "com.x/a", when: "on" },
    ]);
    expect(keymap.resolve(chord("A"))?.command).toBe("core.a");
    ctx.set("on", true);
    expect(keymap.resolve(chord("A"))?.command).toBe("com.x/a");
  });

  it("利用者の -command が、下の層の同じ割り当てを無効にする", () => {
    const { keymap, chord } = setup();
    keymap.setLayer("core", "core", [
      { key: "Ctrl+D", command: "core.duplicate" },
      { key: "Ctrl+B", command: "core.b" },
    ]);
    keymap.setLayer("user", "user", [
      { key: "Ctrl+D", command: "-core.duplicate" },
    ]);
    expect(keymap.resolve(chord("Ctrl+D"))).toBeNull();
    expect(keymap.resolve(chord("Ctrl+B"))?.command).toBe("core.b");
  });

  it("-command は、別のコマンドの割り当てには効かない", () => {
    const { keymap, chord } = setup();
    keymap.setLayer("core", "core", [
      { key: "Ctrl+D", command: "core.duplicate" },
    ]);
    keymap.setLayer("user", "user", [
      { key: "Ctrl+D", command: "-core.other" },
    ]);
    expect(keymap.resolve(chord("Ctrl+D"))?.command).toBe("core.duplicate");
  });

  it("利用者がキーを付け替えると、新しいキーで動き、元のキーでは動かない", () => {
    const { keymap, chord } = setup();
    keymap.setLayer("core", "core", [
      { key: "Ctrl+D", command: "core.duplicate" },
    ]);
    keymap.setLayer("user", "user", [
      { key: "Ctrl+D", command: "-core.duplicate" },
      { key: "Ctrl+Shift+D", command: "core.duplicate" },
    ]);
    expect(keymap.resolve(chord("Ctrl+D"))).toBeNull();
    expect(keymap.resolve(chord("Ctrl+Shift+D"))?.command).toBe(
      "core.duplicate",
    );
  });

  it("setLayer の Disposable で、その層が外れる", () => {
    const { keymap, chord } = setup();
    const handle = keymap.setLayer("extension", "com.x", [
      { key: "Ctrl+K", command: "x" },
    ]);
    handle.dispose();
    expect(keymap.resolve(chord("Ctrl+K"))).toBeNull();
  });

  it("同じ層・同じ追加元の setLayer は、前の内容を置き換える", () => {
    const { keymap, chord } = setup();
    keymap.setLayer("user", "user", [{ key: "Ctrl+K", command: "old" }]);
    keymap.setLayer("user", "user", [{ key: "Ctrl+J", command: "new" }]);
    expect(keymap.resolve(chord("Ctrl+K"))).toBeNull();
    expect(keymap.resolve(chord("Ctrl+J"))?.command).toBe("new");
  });

  it("macOS では、コアと拡張機能の Ctrl は Cmd になり、利用者の Ctrl はそのまま", () => {
    const { keymap, chord } = setup("mac");
    keymap.setLayer("core", "core", [{ key: "Ctrl+S", command: "core.save" }]);
    keymap.setLayer("user", "user", [{ key: "Ctrl+T", command: "user.t" }]);
    expect(keymap.resolve(chord("Ctrl+S"))?.command).toBe("core.save");
    const literal = chordFromEvent({
      key: "t",
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    });
    expect(keymap.resolve(literal)?.command).toBe("user.t");
  });

  it("bindingsFor が、コマンドに割り当てられたキーを返す（無効化されたものは除く）", () => {
    const { keymap } = setup();
    keymap.setLayer("core", "core", [
      { key: "Ctrl+Y", command: "core.redo" },
      { key: "Ctrl+Shift+Z", command: "core.redo" },
    ]);
    expect(keymap.bindingsFor("core.redo").map((b) => b.key)).toEqual([
      "Ctrl+Y",
      "Ctrl+Shift+Z",
    ]);
    keymap.setLayer("user", "user", [{ key: "Ctrl+Y", command: "-core.redo" }]);
    expect(keymap.bindingsFor("core.redo").map((b) => b.key)).toEqual([
      "Ctrl+Shift+Z",
    ]);
  });

  it("変更を購読できる", () => {
    const { keymap } = setup();
    const listener = vi.fn();
    keymap.subscribe(listener);
    keymap.setLayer("core", "core", [{ key: "A", command: "x" }]);
    expect(listener).toHaveBeenCalled();
  });
});

describe("キーマップの検証", () => {
  it("要素ごとに検証し、不正なものだけを無視して keybinding.invalid を報告する", () => {
    const { keymap, problems, chord } = setup();
    keymap.setLayer("user", "user", [
      { key: "Ctrl+K", command: "ok" },
      { key: "Bogus+K", command: "bad-key" },
      { key: "Ctrl+L", command: "" },
      { key: "", command: "empty-key" },
      { key: "Ctrl+M" } as never,
      "string" as never,
      null as never,
      { key: "Ctrl+N", command: "has-bad-when", when: "a &&" },
    ]);
    expect(keymap.resolve(chord("Ctrl+K"))?.command).toBe("ok");
    expect(
      problems.filter((p) => p.code === "keybinding.invalid"),
    ).toHaveLength(6);
    // when の構文エラーは、実際に評価されるときに when.syntax になり、偽として扱われる
    expect(keymap.resolve(chord("Ctrl+N"))).toBeNull();
  });
});

describe("衝突の検出", () => {
  it("同じ層・同じ when・異なるコマンドを conflict にして報告する", () => {
    const { keymap, problems } = setup();
    keymap.setLayer("user", "user", [
      { key: "Ctrl+K", command: "a" },
      { key: "Ctrl+K", command: "b" },
    ]);
    const conflicts = keymap.conflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe("conflict");
    if (conflicts[0]?.kind === "conflict") {
      expect(conflicts[0].bindings.map((b) => b.command)).toEqual(["a", "b"]);
      expect(conflicts[0].when).toBeNull();
    }
    expect(problems.some((p) => p.code === "keybinding.conflict")).toBe(true);
  });

  it("同じコマンドの重複は、衝突ではない", () => {
    const { keymap } = setup();
    keymap.setLayer("user", "user", [
      { key: "Ctrl+K", command: "a" },
      { key: "Ctrl+K", command: "a" },
    ]);
    expect(keymap.conflicts()).toEqual([]);
  });

  it("when が違えば、衝突ではない", () => {
    const { keymap } = setup();
    keymap.setLayer("core", "core", [
      { key: "A", command: "a", when: "x" },
      { key: "A", command: "b", when: "y" },
    ]);
    expect(keymap.conflicts()).toEqual([]);
  });

  it("層が違うものは overridden（どちらが有効かが分かる）", () => {
    const { keymap } = setup();
    keymap.setLayer("core", "core", [{ key: "Ctrl+K", command: "core.k" }]);
    keymap.setLayer("user", "user", [{ key: "Ctrl+K", command: "user.k" }]);
    const conflicts = keymap.conflicts();
    expect(conflicts).toHaveLength(1);
    const first = conflicts[0];
    expect(first?.kind).toBe("overridden");
    if (first?.kind === "overridden") {
      expect(first.winner.command).toBe("user.k");
      expect(first.shadowed.map((b) => b.command)).toEqual(["core.k"]);
    }
  });

  it("-command で無効にしたものは、衝突に数えない", () => {
    const { keymap } = setup();
    keymap.setLayer("core", "core", [{ key: "Ctrl+K", command: "core.k" }]);
    keymap.setLayer("user", "user", [
      { key: "Ctrl+K", command: "-core.k" },
      { key: "Ctrl+K", command: "user.k" },
    ]);
    expect(keymap.conflicts()).toEqual([]);
  });
});
