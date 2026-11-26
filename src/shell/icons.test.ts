import { describe, expect, it } from "vitest";
import { ICON_NAMES, iconShapes, parseIconRef } from "./icons";

describe("アイコン集", () => {
  it("`$(name)` から名前を取り出せる", () => {
    expect(parseIconRef("$(save)")).toBe("save");
    expect(parseIconRef("$(a-b)")).toBe("a-b");
    expect(parseIconRef("icons/x.svg")).toBeNull();
    expect(parseIconRef("$(")).toBeNull();
    expect(parseIconRef(undefined)).toBeNull();
  });

  it("全部のアイコンに、図形の定義がある", () => {
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(40);
    for (const name of ICON_NAMES) {
      const shapes = iconShapes(name);
      expect(shapes.length, name).toBeGreaterThan(0);
      for (const d of shapes)
        expect(d, name).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/);
    }
  });

  it("未知の名前は、例外にせず代わりの図形を返す", () => {
    const fallback = iconShapes("does-not-exist");
    expect(fallback.length).toBeGreaterThan(0);
  });

  it("リボンとコアのコマンドで使う名前がすべてある", () => {
    for (const name of [
      "undo",
      "redo",
      "save",
      "open",
      "new",
      "recent",
      "copy",
      "cut",
      "paste",
      "delete",
      "select-all",
      "duplicate",
      "cursor",
      "tag",
      "relation",
      "group",
      "ungroup",
      "prev",
      "next",
      "next-unfinished",
      "check",
      "flag",
      "primary-sidebar",
      "secondary-sidebar",
      "bottom-panel",
      "primary-sidebar-off",
      "secondary-sidebar-off",
      "bottom-panel-off",
      "eye",
      "label-name",
      "theme",
      "language",
      "schema",
      "assets",
      "extension",
      "install",
      "developer",
      "jobs",
      "stats",
      "settings",
      "project-settings",
      "info",
      "search",
      "explorer",
      "output",
      "problems",
      "close",
      "chevron-down",
      "chevron-right",
      "command",
    ]) {
      expect(ICON_NAMES, name).toContain(name);
    }
  });
});
