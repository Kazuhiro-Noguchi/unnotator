// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Splitter } from "./Splitter";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

function mount(overrides: Partial<Parameters<typeof Splitter>[0]> = {}) {
  const onChange = vi.fn();
  dispose = render(
    () => (
      <Splitter
        orientation="vertical"
        value={200}
        min={100}
        max={400}
        grow={1}
        label="サイドバー"
        onChange={onChange}
        {...overrides}
      />
    ),
    document.body,
  );
  const element = document.querySelector<HTMLElement>('[role="separator"]');
  if (!element) throw new Error("separator が無い");
  return { element, onChange };
}

function press(element: HTMLElement, key: string) {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("Splitter（部品）", () => {
  it("ARIA の separator として、値・最小・最大・向きを持ち、フォーカスできる", () => {
    const { element } = mount();
    expect(element.getAttribute("aria-valuenow")).toBe("200");
    expect(element.getAttribute("aria-valuemin")).toBe("100");
    expect(element.getAttribute("aria-valuemax")).toBe("400");
    expect(element.getAttribute("aria-orientation")).toBe("vertical");
    expect(element.tabIndex).toBe(0);
    expect(element.getAttribute("aria-label")).toContain("サイドバー");
  });

  it("縦の境界: → で広がり、← で狭まる（16px ずつ）", () => {
    const { element, onChange } = mount();
    press(element, "ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith(216);
    press(element, "ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith(184);
  });

  it("grow が -1 なら、向きが逆になる", () => {
    const { element, onChange } = mount({ grow: -1 });
    press(element, "ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith(184);
  });

  it("横の境界: ↓ と ↑ で動き、← → は無視する", () => {
    const { element, onChange } = mount({ orientation: "horizontal" });
    press(element, "ArrowDown");
    expect(onChange).toHaveBeenLastCalledWith(216);
    onChange.mockClear();
    press(element, "ArrowRight");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Home で最小、End で最大にする", () => {
    const { element, onChange } = mount();
    press(element, "Home");
    expect(onChange).toHaveBeenLastCalledWith(100);
    press(element, "End");
    expect(onChange).toHaveBeenLastCalledWith(400);
  });
});
