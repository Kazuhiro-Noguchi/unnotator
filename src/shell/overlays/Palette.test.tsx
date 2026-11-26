// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "../services";
import Palette from "./Palette";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

commands.declare({
  id: "test.palette.alpha",
  title: { ja: "アルファ操作", en: "Alpha action" },
  source: "core",
});
commands.declare({
  id: "test.palette.beta",
  title: { ja: "ベータ操作", en: "Beta action" },
  source: "core",
});
const alphaRun = vi.fn();
commands.provide("test.palette.alpha", alphaRun);

function mount() {
  const onClose = vi.fn();
  dispose = render(() => <Palette onClose={onClose} />, document.body);
  const input = document.querySelector<HTMLInputElement>(".palette-input");
  if (!input) throw new Error("検索欄が無い");
  return { input, onClose };
}

function type(input: HTMLInputElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(input: HTMLInputElement, key: string) {
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

describe("Palette（部品）", () => {
  it("開くと検索欄にフォーカスがあり、コマンドが一覧に並ぶ", () => {
    const { input } = mount();
    expect(document.activeElement).toBe(input);
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(
      0,
    );
  });

  it("入力で絞り込み、一致が無ければ空の案内を出す", () => {
    const { input } = mount();
    type(input, "アルファ");
    const items = [...document.querySelectorAll('[role="option"]')];
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toMatch(/アルファ操作|Alpha action/);
    type(input, "zzzzzzzzzz該当なし");
    expect(document.querySelector(".palette-empty")).not.toBeNull();
  });

  it("Enter で、選んだコマンドを実行して閉じる", () => {
    const { input, onClose } = mount();
    type(input, "アルファ");
    press(input, "Enter");
    expect(alphaRun).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("未提供（処理が結ばれていない）のコマンドは、Enter でも実行されず、閉じない", () => {
    const { input, onClose } = mount();
    type(input, "ベータ");
    const item = document.querySelector('[role="option"]');
    expect(item?.getAttribute("aria-disabled")).toBe("true");
    press(input, "Enter");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("↓ ↑ で選択が動く（端で回る）", () => {
    const { input } = mount();
    const selected = () =>
      [...document.querySelectorAll('[role="option"]')].findIndex(
        (item) => item.getAttribute("aria-selected") === "true",
      );
    expect(selected()).toBe(0);
    press(input, "ArrowDown");
    expect(selected()).toBe(1);
    press(input, "ArrowUp");
    press(input, "ArrowUp");
    expect(selected()).toBe(
      document.querySelectorAll('[role="option"]').length - 1,
    );
  });
});
