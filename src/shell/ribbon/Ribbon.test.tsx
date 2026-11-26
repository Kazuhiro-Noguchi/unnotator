// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { backstageOpen, ribbonSelected, setBackstageOpen } from "../ui-state";
import { Ribbon } from "./Ribbon";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  setBackstageOpen(false);
});

function tabs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
}

describe("Ribbon（部品）", () => {
  it("tablist の中に、ファイルとホームのタブがあり、ホームが選ばれている", () => {
    dispose = render(() => <Ribbon />, document.body);
    expect(document.querySelector('[role="tablist"]')).not.toBeNull();
    const list = tabs();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0]?.classList.contains("file-tab")).toBe(true);
    const selected = list.filter(
      (tab) => tab.getAttribute("aria-selected") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(ribbonSelected()).toBe("home");
  });

  it("ファイルのタブを押すと Backstage が開き、選択中のタブは変わらない", () => {
    dispose = render(() => <Ribbon />, document.body);
    tabs()[0]?.click();
    expect(backstageOpen()).toBe(true);
    expect(ribbonSelected()).toBe("home");
  });

  it("ボディは tabpanel で、クイックアクセスとレイアウトの切替が並ぶ", () => {
    dispose = render(() => <Ribbon />, document.body);
    expect(document.querySelector('[role="tabpanel"]')).not.toBeNull();
    expect(document.querySelector(".ribbon-top")).not.toBeNull();
  });
});
