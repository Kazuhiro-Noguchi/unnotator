import { describe, expect, it } from "vitest";
import { fakeKeyEvent } from "../testing/fakes";
import { chordFromEvent, chordId, formatKey, parseKey } from "./chord";

const base = { ctrl: false, shift: false, alt: false, meta: false };

describe("parseKey", () => {
  it("修飾キーとキーに分け、小文字に正規化する", () => {
    expect(parseKey("Ctrl+Shift+P", "other")).toEqual({
      ...base,
      ctrl: true,
      shift: true,
      key: "p",
    });
    expect(parseKey("alt+x", "other")).toEqual({
      ...base,
      alt: true,
      key: "x",
    });
  });

  it("修飾キーの順序・大文字小文字・空白を問わない", () => {
    expect(parseKey("shift + ctrl + p", "other")).toEqual(
      parseKey("Ctrl+Shift+P", "other"),
    );
    expect(parseKey("SHIFT+CTRL+P", "other")).toEqual(
      parseKey("Ctrl+Shift+P", "other"),
    );
  });

  it("別名: Cmd / Meta / Command、Esc / Escape、PgUp / PageUp、Del / Delete、Return / Enter", () => {
    expect(parseKey("Cmd+S", "other")).toEqual(parseKey("Meta+S", "other"));
    expect(parseKey("Command+S", "other")).toEqual(parseKey("Meta+S", "other"));
    expect(parseKey("Esc", "other")?.key).toBe("escape");
    expect(parseKey("Escape", "other")?.key).toBe("escape");
    expect(parseKey("PgUp", "other")?.key).toBe("pageup");
    expect(parseKey("PageDown", "other")?.key).toBe("pagedown");
    expect(parseKey("Del", "other")?.key).toBe("delete");
    expect(parseKey("Return", "other")?.key).toBe("enter");
    expect(parseKey("Up", "other")?.key).toBe("arrowup");
    expect(parseKey("Space", "other")?.key).toBe("space");
  });

  it("数字・Tab・Delete などの単独のキー", () => {
    expect(parseKey("1", "other")).toEqual({ ...base, key: "1" });
    expect(parseKey("Tab", "other")).toEqual({ ...base, key: "tab" });
    expect(parseKey("Shift+Tab", "other")).toEqual({
      ...base,
      shift: true,
      key: "tab",
    });
    expect(parseKey("Delete", "other")).toEqual({ ...base, key: "delete" });
  });

  it("キーが + のとき", () => {
    expect(parseKey("Ctrl++", "other")).toEqual({
      ...base,
      ctrl: true,
      key: "+",
    });
    expect(parseKey("+", "other")).toEqual({ ...base, key: "+" });
  });

  it("macOS では、Ctrl を Cmd（meta）に読み替える。明示の Ctrl はそのまま", () => {
    expect(parseKey("Ctrl+S", "mac")).toEqual({
      ...base,
      meta: true,
      key: "s",
    });
    expect(parseKey("Ctrl+S", "mac", { literalCtrl: true })).toEqual({
      ...base,
      ctrl: true,
      key: "s",
    });
    expect(parseKey("Cmd+S", "mac", { literalCtrl: true })).toEqual({
      ...base,
      meta: true,
      key: "s",
    });
    expect(parseKey("Ctrl+S", "other")).toEqual({
      ...base,
      ctrl: true,
      key: "s",
    });
  });

  it("不正な文字列は null", () => {
    for (const text of [
      "",
      " ",
      "Ctrl+",
      "Ctrl+Shift",
      "Ctrl+A+B",
      "Foo+A",
      "++",
      "Ctrl+Ctrl",
    ]) {
      expect(parseKey(text, "other"), text).toBeNull();
    }
  });

  it("記号の Shift は、文字そのものが持つので chord に含めない", () => {
    expect(parseKey("?", "other")).toEqual({ ...base, key: "?" });
  });
});

describe("chordFromEvent", () => {
  it("event.key を小文字にし、修飾キーを写す", () => {
    expect(
      chordFromEvent(fakeKeyEvent({ key: "P", ctrlKey: true, shiftKey: true })),
    ).toEqual({
      ...base,
      ctrl: true,
      shift: true,
      key: "p",
    });
  });

  it("別名をそろえる（' ' → space、'Esc' → escape）", () => {
    expect(chordFromEvent(fakeKeyEvent({ key: " " })).key).toBe("space");
    expect(chordFromEvent(fakeKeyEvent({ key: "Escape" })).key).toBe("escape");
    expect(chordFromEvent(fakeKeyEvent({ key: "ArrowUp" })).key).toBe(
      "arrowup",
    );
  });

  it("記号の shift は無視する（? は Shift+/ ではなく ?）", () => {
    expect(chordFromEvent(fakeKeyEvent({ key: "?", shiftKey: true }))).toEqual({
      ...base,
      key: "?",
    });
  });

  it("文字と数字の shift は残す", () => {
    expect(
      chordFromEvent(fakeKeyEvent({ key: "Tab", shiftKey: true })).shift,
    ).toBe(true);
    expect(
      chordFromEvent(fakeKeyEvent({ key: "Z", shiftKey: true, ctrlKey: true }))
        .shift,
    ).toBe(true);
  });

  it("宣言した文字列と、イベントが一致する", () => {
    const declared = parseKey("Ctrl+Shift+P", "other");
    const pressed = chordFromEvent(
      fakeKeyEvent({ key: "P", ctrlKey: true, shiftKey: true }),
    );
    expect(chordId(pressed)).toBe(chordId(declared as never));
  });
});

describe("formatKey", () => {
  it("Windows / Linux は Ctrl+Shift+P の形", () => {
    expect(formatKey(parseKey("Ctrl+Shift+P", "other") as never, "other")).toBe(
      "Ctrl+Shift+P",
    );
    expect(formatKey(parseKey("Escape", "other") as never, "other")).toBe(
      "Esc",
    );
    expect(formatKey(parseKey("PageUp", "other") as never, "other")).toBe(
      "PgUp",
    );
    expect(formatKey(parseKey("Delete", "other") as never, "other")).toBe(
      "Del",
    );
  });

  it("macOS は記号で表す", () => {
    expect(formatKey(parseKey("Ctrl+Shift+P", "mac") as never, "mac")).toBe(
      "⇧⌘P",
    );
    expect(formatKey(parseKey("Alt+X", "mac") as never, "mac")).toBe("⌥X");
  });

  it("parseKey で読み直すと、同じ chord になる", () => {
    for (const text of [
      "Ctrl+Z",
      "Ctrl+Shift+Z",
      "Shift+Tab",
      "PageUp",
      "1",
      "Ctrl+Enter",
    ]) {
      const chord = parseKey(text, "other") as never;
      expect(parseKey(formatKey(chord, "other"), "other")).toEqual(chord);
    }
  });
});
