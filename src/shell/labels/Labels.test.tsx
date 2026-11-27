// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n";
import type { Command, LabelRow } from "../project-data/types";
import { LabelsView, type LabelsViewProps } from "./LabelsView";

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
      }
      return { seq: 1, origin: "apply", changes: [], asset_ids: [] };
    },
  };
  const notify: LabelsViewProps["notify"] = (_level, text) => {
    notes.push(text);
  };
  dispose = render(() => <LabelsView data={data} notify={notify} />, root);
  return { root, applied, notes };
}

const names = (root: HTMLElement) =>
  [...root.querySelectorAll(".label-name")].map((e) => e.textContent);

function type(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("LabelsView", () => {
  it("ラベルを並べ、名前で絞り込める", async () => {
    const { root } = mount([row("1", "cat", 1), row("2", "dog")]);
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

  it("追加フォームで、名前とショートカットキーを入れて保存すると、create_label が渡る", async () => {
    const { root, applied } = mount([row("1", "cat", 1)]);
    (
      root.querySelector(".labels-toolbar .button") as HTMLButtonElement
    ).click();
    await flush();
    type(
      root.querySelector(".label-form input[type=text]") as HTMLInputElement,
      "bird",
    );
    const select = root.querySelector(
      ".label-form select",
    ) as HTMLSelectElement;
    select.value = "3";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    (
      root.querySelector(".label-form button[type=submit]") as HTMLButtonElement
    ).click();
    await flush();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      kind: "create_label",
      name: "bird",
      hotkey: 3,
    });
    expect(names(root)).toEqual(["cat", "bird"]);
    expect(root.querySelector(".label-form")).toBeNull();
  });

  it("重複する名前・キーは、保存せずに理由を出す", async () => {
    const { root, applied } = mount([row("1", "cat", 1)]);
    (
      root.querySelector(".labels-toolbar .button") as HTMLButtonElement
    ).click();
    await flush();
    type(
      root.querySelector(".label-form input[type=text]") as HTMLInputElement,
      "cat",
    );
    const select = root.querySelector(
      ".label-form select",
    ) as HTMLSelectElement;
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    (
      root.querySelector(".label-form button[type=submit]") as HTMLButtonElement
    ).click();
    await flush();
    expect(applied).toEqual([]);
    expect(root.querySelectorAll(".form-errors li")).toHaveLength(2);
  });

  it("保存に失敗したら、エラーを知らせてフォームを残す", async () => {
    const { root, notes } = mount([], true);
    (
      root.querySelector(".labels-toolbar .button") as HTMLButtonElement
    ).click();
    await flush();
    type(
      root.querySelector(".label-form input[type=text]") as HTMLInputElement,
      "x",
    );
    (
      root.querySelector(".label-form button[type=submit]") as HTMLButtonElement
    ).click();
    await flush();
    expect(notes).toHaveLength(1);
    expect(root.querySelector(".label-form")).not.toBeNull();
  });

  it("非表示のラベルは、印を付けて並べる", () => {
    const { root } = mount([row("1", "cat", null, true)]);
    expect(root.querySelector(".label-item.hidden")).not.toBeNull();
  });
});
