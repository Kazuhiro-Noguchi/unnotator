// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n";
import { LabelsHeaderActions } from "./HeaderActions";
import { createLabelsUi } from "./ui";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount() {
  const ui = createLabelsUi();
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => <LabelsHeaderActions ui={ui} />, root);
  const button = (label: string) =>
    root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  return { ui, root, button };
}

describe("LabelsHeaderActions（見出しの右端のアイコン）", () => {
  it("ラベルの追加と、絞り込みの、2 つのアイコンのボタンがある", () => {
    const { button } = mount();
    expect(button(t("labels.add"))).not.toBeNull();
    expect(button(t("labels.filter"))).not.toBeNull();
  });

  it("追加のアイコンで、一覧が登録した追加の処理が呼ばれる（登録が無ければ、何も起きない）", async () => {
    const { ui, button } = mount();
    button(t("labels.add"))?.click();
    await flush();
    let calls = 0;
    ui.setCreateHandler(() => {
      calls += 1;
    });
    button(t("labels.add"))?.click();
    await flush();
    expect(calls).toBe(1);
    ui.setCreateHandler(null);
    button(t("labels.add"))?.click();
    expect(calls).toBe(1);
  });

  it("絞り込みのアイコンで、入力の表示を切り替える。閉じると、条件も外れる", async () => {
    const { ui, button } = mount();
    const filter = button(t("labels.filter"));
    filter?.click();
    await flush();
    expect(ui.filterOpen()).toBe(true);
    expect(filter?.getAttribute("aria-pressed")).toBe("true");
    ui.setQuery("cat");
    filter?.click();
    await flush();
    expect(ui.filterOpen()).toBe(false);
    expect(ui.query()).toBe("");
  });
});
