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

function mount(selected = false) {
  const ui = createLabelsUi();
  const deselected: string[] = [];
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <LabelsHeaderActions
        ui={ui}
        hasSelection={() => selected}
        onDeselect={() => {
          deselected.push("x");
        }}
      />
    ),
    root,
  );
  const button = (label: string) =>
    root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  return { ui, root, button, deselected };
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

  it("選択解除のアイコン: 選択があるときだけ押せて、押すと解除を頼む。ツールチップに、ショートカット（Esc）を出す", async () => {
    const none = mount(false);
    expect(none.button(t("labels.deselect"))?.disabled).toBe(true);
    dispose?.();
    document.body.innerHTML = "";
    const some = mount(true);
    const deselect = some.button(t("labels.deselect"));
    expect(deselect?.disabled).toBe(false);
    expect(deselect?.title).toContain("Esc");
    deselect?.click();
    await flush();
    expect(some.deselected).toHaveLength(1);
  });

  it("アイコンの並びは、絞り込み・選択解除・追加（追加が右端）", () => {
    const { root } = mount(true);
    const labels = [...root.querySelectorAll("button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels).toEqual([
      t("labels.filter"),
      t("labels.deselect"),
      t("labels.add"),
    ]);
  });
});
