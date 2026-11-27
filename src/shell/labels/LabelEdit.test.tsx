// @vitest-environment happy-dom
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n";
import type { Command, LabelRow, LabelUsage } from "../project-data/types";
import { LabelsView, type LabelsViewProps } from "./LabelsView";
import { createLabelsUi } from "./ui";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

const row = (
  id: string,
  name: string,
  hotkey: number | null = null,
  sort_order = 0,
): LabelRow => ({
  id,
  name,
  name_i18n_json: "{}",
  color: "#112233",
  hotkey,
  sort_order,
  hidden: false,
  applies_to_json: "{}",
});

function mount(labels: LabelRow[], usage: Partial<LabelUsage> = {}) {
  const applied: Command[] = [];
  const root = document.createElement("div");
  document.body.append(root);
  const data: LabelsViewProps["data"] = {
    labels: () => labels,
    subscribe: () => () => {},
    labelUsage: async () => ({
      annotations: 0,
      relations: 0,
      groups: 0,
      attribute_schemas: 0,
      ...usage,
    }),
    apply: async (command) => {
      applied.push(command);
      return { seq: 1, origin: "apply", changes: [], asset_ids: [] };
    },
  };
  const notify: LabelsViewProps["notify"] = () => {};
  const ui = createLabelsUi();
  const picked: string[] = [];
  const pickedModes: string[] = [];
  const pickedOrders: string[][] = [];
  const [selectedIds, setSelectedIds] = createSignal<ReadonlySet<string>>(
    new Set<string>(),
  );
  dispose = render(
    () => (
      <LabelsView
        data={data}
        notify={notify}
        ui={ui}
        selectedIds={selectedIds}
        onPick={(label, mode, order) => {
          picked.push(label.id);
          pickedModes.push(mode);
          pickedOrders.push([...order]);
        }}
      />
    ),
    root,
  );
  return {
    root,
    applied,
    ui,
    picked,
    pickedModes,
    pickedOrders,
    setSelectedIds,
  };
}

const itemButtons = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll<HTMLElement>(".label-item")]
    .find((li) => li.querySelector(".label-name")?.textContent === name)
    ?.querySelectorAll<HTMLButtonElement>("button") ?? [];

const labelled = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text || b.getAttribute("aria-label") === text,
  );

/** 削除は、編集（鉛筆）を開いて、フォームの「削除」から行う。 */
async function openDelete(root: HTMLElement, name: string) {
  const card = [...root.querySelectorAll<HTMLElement>(".label-item")].find(
    (li) => li.querySelector(".label-name")?.textContent === name,
  );
  card
    ?.querySelector<HTMLButtonElement>(
      `button[aria-label="${t("labels.edit")}"]`,
    )
    ?.click();
  await flush();
  card?.querySelector<HTMLButtonElement>(".label-form .danger")?.click();
  await flush();
}

describe("ラベルの編集・並べ替え・削除", () => {
  it("編集では、自分のキーは選べて、他のラベルのキーは選択肢に出ない", async () => {
    const { root } = mount([row("1", "cat", 1), row("2", "dog", 2)]);
    [...itemButtons(root, "dog")]
      .find((b) => b.getAttribute("aria-label") === t("labels.edit"))
      ?.click();
    await flush();
    const options = [
      ...root.querySelectorAll<HTMLOptionElement>(".label-form select option"),
    ].map((o) => o.value);
    expect(options).toContain("2");
    expect(options).not.toContain("1");
    const select = root.querySelector(
      ".label-form select",
    ) as HTMLSelectElement;
    expect(select.value).toBe("2");
  });

  const swapped = {
    kind: "transaction",
    commands: [
      {
        kind: "update_label",
        id: "2",
        patch: { sort_order: { kind: "set", value: 0 } },
      },
      {
        kind: "update_label",
        id: "1",
        patch: { sort_order: { kind: "set", value: 1 } },
      },
    ],
  };

  /** カードの位置を決める（happy-dom には、レイアウトが無い）。1 枚 40px・間隔 10px。 */
  function layout(root: HTMLElement) {
    root.querySelectorAll<HTMLElement>(".label-card").forEach((el, i) => {
      el.getBoundingClientRect = () =>
        ({ top: i * 50, height: 40, bottom: i * 50 + 40 }) as DOMRect;
    });
  }
  const grip = (root: HTMLElement, name: string) =>
    [...root.querySelectorAll<HTMLElement>(".label-item")]
      .find((li) => li.querySelector(".label-name")?.textContent === name)
      ?.querySelector<HTMLElement>(".label-grip");
  const pointer = (el: Element | null | undefined, type: string, y = 0) =>
    el?.dispatchEvent(
      new MouseEvent(type, { bubbles: true, button: 0, clientY: y }),
    );

  it("上下の矢印ボタンは無い。つかみ（グリップ）のキーボード操作で、1 つ下へ動かせる", async () => {
    const { root, applied } = mount([
      row("1", "a", null, 0),
      row("2", "b", null, 1),
    ]);
    expect(labelled(root, t("labels.moveDown"))).toBeUndefined();
    expect(labelled(root, t("labels.moveUp"))).toBeUndefined();
    grip(root, "a")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await flush();
    expect(applied).toEqual([swapped]);
  });

  it("ドラッグして、2 つ目の下で離すと、並び順を振り直す", async () => {
    const { root, applied } = mount([
      row("1", "a", null, 0),
      row("2", "b", null, 1),
    ]);
    layout(root);
    const handle = grip(root, "a");
    pointer(handle, "pointerdown", 20);
    pointer(handle, "pointermove", 95);
    await flush();
    // ドラッグ中は、動かすカードが薄くなり、挿入位置（最後の後ろ）に目印が出る
    expect(root.querySelector(".label-card.dragging")).not.toBeNull();
    expect(root.querySelector(".label-card.drop-end")).not.toBeNull();
    pointer(handle, "pointerup", 95);
    await flush();
    expect(applied).toEqual([swapped]);
    expect(root.querySelector(".dragging")).toBeNull();
  });

  it("元の位置の近くで離す・キャンセルしたときは、何も書かない", async () => {
    const { root, applied } = mount([
      row("1", "a", null, 0),
      row("2", "b", null, 1),
    ]);
    layout(root);
    const handle = grip(root, "a");
    pointer(handle, "pointerdown", 20);
    pointer(handle, "pointermove", 25);
    pointer(handle, "pointerup", 25);
    pointer(handle, "pointerdown", 20);
    pointer(handle, "pointermove", 95);
    pointer(handle, "pointercancel", 95);
    await flush();
    expect(applied).toEqual([]);
    expect(root.querySelector(".dragging")).toBeNull();
  });

  it("名前で絞り込んでいるあいだは、つかみを出さない", async () => {
    const { root, ui } = mount([
      row("1", "a", null, 0),
      row("2", "b", null, 1),
    ]);
    expect(grip(root, "a") ?? null).not.toBeNull();
    ui.setFilterOpen(true);
    await flush();
    const input = root.querySelector<HTMLInputElement>(".filter-name");
    if (input === null) throw new Error("絞り込みが無い");
    input.value = "a";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(grip(root, "a") ?? null).toBeNull();
  });

  it("使われていないラベルは、選択なしで削除できる", async () => {
    const { root, applied } = mount([row("1", "cat")]);
    await openDelete(root, "cat");
    expect(root.querySelector(".label-delete")?.textContent).toContain(
      t("labels.delete.unused"),
    );
    (root.querySelector(".label-delete .primary") as HTMLButtonElement).click();
    await flush();
    expect(applied).toEqual([
      { kind: "delete_label", id: "1", disposition: null },
    ]);
  });

  it("使用中のラベルは、件数を示し、一緒に削除（既定）か、付け替えを選ぶ", async () => {
    const { root, applied } = mount([row("1", "cat"), row("2", "dog")], {
      annotations: 3,
    });
    await openDelete(root, "cat");
    expect(root.querySelector(".label-delete")?.textContent).toContain("3");
    const radios = root.querySelectorAll<HTMLInputElement>(
      ".label-delete input[type=radio]",
    );
    radios[0]?.click();
    radios[0]?.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    (root.querySelector(".label-delete .primary") as HTMLButtonElement).click();
    await flush();
    expect(applied).toEqual([
      {
        kind: "delete_label",
        id: "1",
        disposition: { kind: "reassign", to_label_id: "2" },
      },
    ]);
  });

  it("削除のボタンは、カードに出さず、編集の中にだけある", async () => {
    const { root } = mount([row("1", "cat")]);
    const card = root.querySelector<HTMLElement>(".label-item");
    const names = [...(card?.querySelectorAll("button") ?? [])].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(names).not.toContain(t("labels.delete"));
    expect(card?.querySelector(".label-form .danger")).toBeNull();
    labelled(root, t("labels.edit"))?.click();
    await flush();
    expect(card?.querySelector(".label-form .danger")?.textContent).toBe(
      t("labels.delete"),
    );
  });

  it("非表示のアイコンで、表示と非表示を切り替える（update_label）", async () => {
    const { root, applied } = mount([row("1", "cat")]);
    labelled(root, t("labels.hide"))?.click();
    await flush();
    expect(applied).toEqual([
      {
        kind: "update_label",
        id: "1",
        patch: { hidden: { kind: "set", value: true } },
      },
    ]);
  });

  it("非表示のラベルは、目に斜線のアイコンで『表示する』になる", () => {
    const hidden = { ...row("1", "cat"), hidden: true };
    const { root } = mount([hidden]);
    expect(labelled(root, t("labels.show"))).not.toBeUndefined();
    expect(labelled(root, t("labels.hide"))).toBeUndefined();
  });

  const card = (root: HTMLElement, name: string) =>
    [...root.querySelectorAll<HTMLElement>(".label-item")].find(
      (li) => li.querySelector(".label-name")?.textContent === name,
    );
  const selectedNames = (root: HTMLElement) =>
    [...root.querySelectorAll(".label-card.selected .label-name")].map(
      (e) => e.textContent,
    );

  it("カードをクリックすると、そのラベルを選ぶ（onPick）。選択の表示は、渡された選択に従う（複数も）", async () => {
    const { root, picked, setSelectedIds } = mount([
      row("1", "a"),
      row("2", "b"),
      row("3", "c"),
    ]);
    expect(selectedNames(root)).toEqual([]);
    card(root, "a")?.click();
    await flush();
    expect(picked).toEqual(["1"]);
    // クリックだけでは、表示は変わらない（選択は、呼び出し側が決めて、渡す）
    expect(selectedNames(root)).toEqual([]);
    setSelectedIds(new Set(["1"]));
    await flush();
    expect(selectedNames(root)).toEqual(["a"]);
    expect(card(root, "a")?.getAttribute("aria-current")).toBe("true");
    expect(card(root, "b")?.getAttribute("aria-current")).toBeNull();
    // 複数の選択も、そのまま表示される
    setSelectedIds(new Set(["1", "3"]));
    await flush();
    expect(selectedNames(root)).toEqual(["a", "c"]);
    setSelectedIds(new Set<string>());
    await flush();
    expect(selectedNames(root)).toEqual([]);
  });

  it("クリックの種類: 通常も Ctrl / Cmd も足し引き、Shift は範囲。見えている並びも渡す", async () => {
    const { root, pickedModes, pickedOrders } = mount([
      row("1", "a"),
      row("2", "b"),
      row("3", "c"),
    ]);
    const click = (name: string, init: MouseEventInit = {}) =>
      card(root, name)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, ...init }),
      );
    click("a");
    click("b", { ctrlKey: true });
    click("c", { metaKey: true });
    click("c", { shiftKey: true });
    await flush();
    expect(pickedModes).toEqual(["toggle", "toggle", "toggle", "range"]);
    expect(pickedOrders[0]).toEqual(["1", "2", "3"]);
  });

  it("キーボード: 「選ぶ」ボタン（Enter / Space）で選ぶ。↑ ↓ は、隣へフォーカスを移すだけ", async () => {
    const { root, picked } = mount([row("1", "a"), row("2", "b")]);
    const pick = (name: string) =>
      card(root, name)?.querySelector<HTMLElement>(".label-pick");
    pick("a")?.click();
    await flush();
    expect(picked).toEqual(["1"]);
    pick("a")?.focus();
    pick("a")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await flush();
    // 選ぶ操作は、起きない
    expect(picked).toEqual(["1"]);
    expect(document.activeElement).toBe(pick("b"));
  });

  it("鉛筆・目・つかみ・編集フォームを押しても、選ぶ操作は起きない", async () => {
    const { root, picked } = mount([row("1", "a"), row("2", "b")]);
    for (const label of [t("labels.edit"), t("labels.hide")]) {
      card(root, "b")
        ?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
        ?.click();
      await flush();
    }
    card(root, "b")?.querySelector<HTMLElement>(".label-grip")?.click();
    card(root, "b")?.querySelector<HTMLElement>(".label-form input")?.click();
    await flush();
    expect(picked).toEqual([]);
  });
});
