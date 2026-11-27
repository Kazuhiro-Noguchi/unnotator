// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n";
import type { Command, SchemaRow } from "../project-data/types";
import { AttributeForm } from "./AttributeForm";
import type { FormField } from "./derive-form";
import { SchemaEditor, type SchemaEditorProps } from "./SchemaEditor";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function change(el: HTMLInputElement | HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const fields: FormField[] = [
  { name: "sides", title: "辺の数", kind: "integer", required: true },
  {
    name: "age",
    title: "年齢層",
    kind: "enum",
    required: false,
    options: ["child", "adult"],
  },
];

function mountForm(attributes: Record<string, unknown>) {
  const commits: Array<Record<string, unknown>> = [];
  const root = document.createElement("div");
  document.body.append(root);
  const onCommit = (next: Record<string, unknown>) => {
    commits.push(next);
  };
  dispose = render(
    () => (
      <AttributeForm
        fields={fields}
        attributes={attributes}
        onCommit={onCommit}
      />
    ),
    root,
  );
  return { root, commits };
}

describe("AttributeForm", () => {
  it("必須の欄が空なら、警告を出す。保存済みの値は消さない", () => {
    const { root } = mountForm({ extra: 1 });
    expect(root.querySelector(".field-error")?.textContent).toBe(
      t("schema.error.required"),
    );
  });

  it("型に合わない入力は確定せず、理由を示す。直すと確定する（ほかのキーは残す）", async () => {
    const { root, commits } = mountForm({ extra: 1 });
    const input = root.querySelector("input[type=text]") as HTMLInputElement;
    change(input, "1.5");
    await flush();
    expect(commits).toEqual([]);
    expect(root.textContent).toContain(t("schema.error.integer"));
    change(input, "4");
    await flush();
    expect(commits).toEqual([{ extra: 1, sides: 4 }]);
  });

  it("選択肢の欄は、候補から選ぶ", async () => {
    const { root, commits } = mountForm({ sides: 3 });
    change(root.querySelector("select") as HTMLSelectElement, "adult");
    await flush();
    expect(commits).toEqual([{ sides: 3, age: "adult" }]);
  });

  it("保存済みの値が型に合わなくなっていたら、警告を出す（値は残す）", () => {
    const { root } = mountForm({ sides: "abc" });
    expect(root.textContent).toContain(t("schema.warn.mismatch"));
  });
});

function mountEditor(schemas: SchemaRow[], usage = 0) {
  const applied: Command[] = [];
  const root = document.createElement("div");
  document.body.append(root);
  const data: SchemaEditorProps["data"] = {
    labels: () => [],
    schemas: () => schemas,
    subscribe: () => () => {},
    apply: async (command) => {
      applied.push(command);
      return { seq: 1, origin: "apply", changes: [], asset_ids: [] };
    },
    attributeUsage: async () => usage,
  };
  const notify: SchemaEditorProps["notify"] = () => {};
  dispose = render(() => <SchemaEditor data={data} notify={notify} />, root);
  return { root, applied };
}

const buttons = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLButtonElement>(".form-actions button"),
];

describe("SchemaEditor", () => {
  it("属性を追加して保存すると、set_attribute_schema が渡る", async () => {
    const { root, applied } = mountEditor([]);
    buttons(root)[0]?.click();
    await flush();
    const name = root.querySelector(
      ".schema-prop input[type=text]",
    ) as HTMLInputElement;
    change(name, "quality");
    buttons(root)[1]?.click();
    await flush();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      kind: "set_attribute_schema",
      scope: "global",
      target: "",
    });
    const body = applied[0] as { schema_json: string };
    expect(JSON.parse(body.schema_json).properties).toEqual({
      quality: { type: "string" },
    });
  });

  it("名前が空なら、保存せずに理由を出す", async () => {
    const { root, applied } = mountEditor([]);
    buttons(root)[0]?.click();
    await flush();
    buttons(root)[1]?.click();
    await flush();
    expect(applied).toEqual([]);
    expect(root.querySelector(".schema-prop .field-error")).not.toBeNull();
  });

  it("値が入っている属性を消すときは、件数を示して確認し、確認するまで書かない", async () => {
    const stored: SchemaRow = {
      scope: "global",
      target: "",
      schema_json: JSON.stringify({
        type: "object",
        properties: { a: { type: "string" } },
      }),
    };
    const { root, applied } = mountEditor([stored], 3);
    // 保存済みの属性 a を、行の削除ボタンで消してから保存する
    (root.querySelector(".schema-prop .button") as HTMLButtonElement).click();
    await flush();
    buttons(root)
      .find((b) => b.classList.contains("primary"))
      ?.click();
    await flush();
    expect(applied).toEqual([]);
    expect(root.querySelector(".draft-banner")?.textContent).toContain("3");
    (root.querySelector(".draft-banner .primary") as HTMLButtonElement).click();
    await flush();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      kind: "delete_attribute_schema",
      scope: "global",
    });
  });
});
