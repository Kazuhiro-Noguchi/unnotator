import { describe, expect, it } from "vitest";
import schema from "../../../crates/extensions/schema/unnotator-plugin.schema.json";
import { CORE_COMMANDS } from "../commands/core-commands";
import type { RibbonControl, RibbonTab } from "../types";
import { coreRibbon } from "./core-ribbon";

function controlsOf(control: RibbonControl): RibbonControl[] {
  return [control, ...(control.items ?? []).flatMap(controlsOf)];
}

function allControls(tabs: RibbonTab[]): RibbonControl[] {
  return tabs.flatMap((tab) =>
    tab.groups.flatMap((g) => g.controls.flatMap(controlsOf)),
  );
}

describe("コアのリボンの定義", () => {
  const tabs = coreRibbon();

  it("コアのタブは、ホームだけ（ファイルタブも置かない。ほかのタブは拡張機能が作る）", () => {
    expect(tabs.map((t) => t.id)).toEqual(["home"]);
    const orders = tabs.map((t) => t.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    for (const tab of tabs) {
      expect(tab.contextual).toBe(false);
      expect(tab.source).toBe("core");
    }
  });

  it("グループ ID が contracts/core-catalog.md と一致する", () => {
    const ids = tabs.flatMap((t) => t.groups.map((g) => g.id));
    expect(ids).toEqual([
      "home.clipboard",
      "home.edit",
      "home.tools",
      "home.relations",
      "home.status",
      "home.view",
      "home.project",
    ]);
  });

  it("スキーマの group の説明にあるコアのグループ ID と、コアの定義が一致する", () => {
    const description: string =
      schema.$defs.ribbon.properties.groups.items.properties.group.description;
    const listed = [...description.matchAll(/\bhome\.[a-z]+\b/g)].map(
      (m) => m[0],
    );
    const ours = tabs.flatMap((t) => t.groups.map((g) => g.id));
    expect([...listed].sort()).toEqual([...ours].sort());
  });

  it("リボンが指すコマンドは、すべてコアの一覧にある", () => {
    const known = new Set(CORE_COMMANDS.map((c) => c.id));
    for (const control of allControls(tabs)) {
      if (control.command)
        expect(known.has(control.command), control.command).toBe(true);
    }
  });

  it("7 種のコントロールのうち、コアの定義で 3 種を使う（残りは拡張機能・テスト用）", () => {
    const kinds = new Set(allControls(tabs).map((c) => c.kind));
    for (const kind of ["largeButton", "smallButton", "toggle"]) {
      expect(kinds.has(kind as never), kind).toBe(true);
    }
  });

  it("タブのキーチップは、1 文字（H）", () => {
    const chips = tabs.map((t) => t.keytip);
    expect(chips).toEqual(["H"]);
  });

  it("グループの priority（小さいほど先に縮退）が、表のとおり", () => {
    const priority = Object.fromEntries(
      tabs.flatMap((t) => t.groups).map((g) => [g.id, g.priority]),
    );
    expect(priority["home.clipboard"]).toBe(10);
    expect(priority["home.edit"]).toBe(20);
    expect(priority["home.relations"]).toBe(30);
    expect(priority["home.tools"]).toBe(40);
    expect(priority["home.status"]).toBe(70);
  });

  it("分割ボタンとドロップダウンは、中身を持つ", () => {
    for (const control of allControls(tabs)) {
      if (
        control.kind === "splitButton" ||
        control.kind === "dropdown" ||
        control.kind === "gallery"
      ) {
        expect((control.items ?? []).length, control.kind).toBeGreaterThan(0);
      }
    }
  });

  it("トグルは、状態を表す条件（checked）を持つ", () => {
    for (const control of allControls(tabs)) {
      if (
        control.kind === "toggle" &&
        control.command?.startsWith("core.view.") &&
        control.command.endsWith(".toggle")
      ) {
        if (
          control.command !== "core.view.annotations.toggle" &&
          control.command !== "core.view.labelNames.toggle"
        ) {
          expect(control.checked, control.command).toBeTruthy();
        }
      }
    }
  });
});
