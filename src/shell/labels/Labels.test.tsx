// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n";
import type { Command, LabelRow } from "../project-data/types";
import { LabelsView, type LabelsViewProps } from "./LabelsView";
import { createLabelsUi } from "./ui";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const row = (
  id: string,
  name: string,
  hotkey: number | null = null,
  hidden = false,
): LabelRow => ({
  id,
  name,
  name_i18n_json: "{}",
  color: "#112233",
  hotkey,
  sort_order: 0,
  hidden,
  applies_to_json: "{}",
});

function mount(initial: LabelRow[], fail = false) {
  let labels = initial;
  const listeners = new Set<() => void>();
  const applied: Command[] = [];
  const notes: string[] = [];
  const root = document.createElement("div");
  document.body.append(root);
  const data: LabelsViewProps["data"] = {
    labels: () => labels,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    labelUsage: async () => ({
      annotations: 0,
      relations: 0,
      groups: 0,
      attribute_schemas: 0,
    }),
    apply: async (command) => {
      if (fail) throw new Error("boom");
      applied.push(command);
      if (command.kind === "create_label") {
        labels = [...labels, row("new", command.name, command.hotkey ?? null)];
        for (const listener of listeners) listener();
        return {
          seq: 1,
          origin: "apply",
          changes: [{ entity: "label", id: "new", kind: "created" }],
          asset_ids: [],
        };
      }
      return { seq: 1, origin: "apply", changes: [], asset_ids: [] };
    },
  };
  const notify: LabelsViewProps["notify"] = (_level, text) => {
    notes.push(text);
  };
  const ui = createLabelsUi();
  dispose = render(
    () => <LabelsView data={data} notify={notify} ui={ui} />,
    root,
  );
  return { root, applied, notes, ui };
}

const names = (root: HTMLElement) =>
  [...root.querySelectorAll(".label-name")].map((e) => e.textContent);

function type(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("LabelsView", () => {
  it("ラベルを並べ、名前で絞り込める", async () => {
    const { root, ui } = mount([row("1", "cat", 1), row("2", "dog")]);
    ui.setFilterOpen(true);
    await flush();
    expect(names(root)).toEqual(["cat", "dog"]);
    expect(root.querySelector(".label-key")?.textContent).toBe("1");
    type(root.querySelector(".filter-name") as HTMLInputElement, "do");
    await flush();
    expect(names(root)).toEqual(["dog"]);
    type(root.querySelector(".filter-name") as HTMLInputElement, "zzz");
    await flush();
    expect(root.querySelector(".label-empty")?.textContent).toBe(
      t("labels.noMatch"),
    );
  });

  const openEdit = async (root: HTMLElement, name: string) => {
    [...root.querySelectorAll<HTMLElement>(".label-item")]
      .find((li) => li.querySelector(".label-name")?.textContent === name)
      ?.querySelector<HTMLButtonElement>(
        `button[aria-label="${t("labels.edit")}"]`,
      )
      ?.click();
    await flush();
  };

  it("追加は、すぐに仮の名前のラベルを作り、その編集を開く（保存ボタンは無い）", async () => {
    const { root, applied, ui } = mount([row("1", "cat", 1)]);
    ui.create();
    await flush();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      kind: "create_label",
      name: t("labels.newName"),
    });
    expect(names(root)).toEqual(["cat", t("labels.newName")]);
    const input = root.querySelector<HTMLInputElement>(
      ".label-form input[type=text]",
    );
    expect(input?.value).toBe(t("labels.newName"));
    expect(root.querySelector(".label-form button[type=submit]")).toBeNull();

    expect(
      [...root.querySelectorAll(".label-form button")].map(
        (b) => b.textContent,
      ),
    ).toEqual([t("labels.delete")]);
  });

  it("追加を続けると、仮の名前に数が付く", async () => {
    const { applied, ui } = mount([row("1", "cat", 1)]);
    ui.create();
    await flush();
    ui.create();
    await flush();
    expect(
      applied.map((c) => (c.kind === "create_label" ? c.name : "")),
    ).toEqual([t("labels.newName"), `${t("labels.newName")} 2`]);
  });

  it("名前を変えて確定すると、すぐ update_label が渡る（編集は開いたまま）", async () => {
    const { root, applied } = mount([row("1", "cat", 1)]);
    await openEdit(root, "cat");
    const input = root.querySelector(
      ".label-form input[type=text]",
    ) as HTMLInputElement;
    input.value = "kitten";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(applied).toEqual([
      {
        kind: "update_label",
        id: "1",
        patch: { name: { kind: "set", value: "kitten" } },
      },
    ]);
    expect(root.querySelector(".label-form")).not.toBeNull();
  });

  it("重複する名前・空の名前は、書かずに理由を出す", async () => {
    const { root, applied } = mount([row("1", "cat", 1), row("2", "dog")]);
    await openEdit(root, "dog");
    const input = root.querySelector(
      ".label-form input[type=text]",
    ) as HTMLInputElement;
    input.value = "cat";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(applied).toEqual([]);
    expect(root.querySelectorAll(".form-errors li")).toHaveLength(1);
    input.value = " ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(applied).toEqual([]);
    expect(root.querySelector(".form-errors")?.textContent).toContain(
      t("labels.error.nameEmpty"),
    );
  });

  it("ショートカットキーを選ぶと、すぐ書く。他のラベルが使っているキーは、選択肢に出さない", async () => {
    const { root, applied } = mount([row("1", "cat", 1), row("2", "dog", 3)]);
    await openEdit(root, "cat");
    const select = root.querySelector(
      ".label-form select",
    ) as HTMLSelectElement;
    const options = [...select.querySelectorAll("option")].map((o) => o.value);
    expect(options).toEqual(["", "1", "2", "4", "5", "6", "7", "8", "9"]);
    select.value = "4";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(applied).toEqual([
      {
        kind: "update_label",
        id: "1",
        patch: { hotkey: { kind: "set", value: 4 } },
      },
    ]);
  });

  it("鉛筆は編集の開閉の切り替え。Esc でも閉じる", async () => {
    const { root } = mount([row("1", "cat", 1)]);
    await openEdit(root, "cat");
    expect(root.querySelector(".label-form")).not.toBeNull();
    await openEdit(root, "cat");
    expect(root.querySelector(".label-form")).toBeNull();
    await openEdit(root, "cat");
    root
      .querySelector(".label-form input")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    await flush();
    expect(root.querySelector(".label-form")).toBeNull();
  });

  it("追加に失敗したら、エラーを知らせる", async () => {
    const { notes, ui } = mount([], true);
    ui.create();
    await flush();
    expect(notes).toHaveLength(1);
  });

  it("非表示のラベルは、印を付けて並べる", () => {
    const { root } = mount([row("1", "cat", null, true)]);
    expect(root.querySelector(".label-item.hidden")).not.toBeNull();
  });
});
