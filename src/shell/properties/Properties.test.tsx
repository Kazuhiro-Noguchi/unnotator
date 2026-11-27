// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n";
import { createCurrentStore } from "../explorer/current";
import type {
  AnnotationRow,
  Command,
  LabelRow,
  TargetDetails,
} from "../project-data/types";
import { createDraftStore } from "./draft";
import { Properties, type PropertiesProps } from "./Properties";
import { createSelection } from "./selection";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

const label: LabelRow = {
  id: "l1",
  name: "cat",
  name_i18n_json: "{}",
  color: "#112233",
  hotkey: 1,
  sort_order: 0,
  hidden: false,
  applies_to_json: "{}",
};

const ann = (
  id: string,
  type: string,
  label_id: string | null = null,
): AnnotationRow => ({
  id,
  type,
  type_version: 1,
  label_id,
  attributes_json: "{}",
  summary: id === "c1" ? "" : `s-${id}`,
  z_order: 0,
  source: "manual",
});

function detailsOf(assetId: string): TargetDetails {
  return {
    asset: {
      id: assetId,
      root_key: "",
      rel_path: `${assetId}.png`,
      media_type: "x/image",
      missing: false,
      status: "todo",
      note: null,
      attributes_json: "{}",
    },
    item: null,
    classification: [ann("c1", "core/classification", "l1")],
    annotation_count: 2,
    relations: [],
    groups: [],
  };
}

function mount(fail = false, active: readonly LabelRow[] = []) {
  const current = createCurrentStore();
  const drafts = createDraftStore();
  const selection = createSelection();
  const applied: Command[] = [];
  const notes: string[] = [];
  const classified: string[] = [];
  const listeners = new Set<() => void>();
  let details: TargetDetails | null = null;
  const data: PropertiesProps["data"] = {
    labels: () => [label],
    schemas: () => [],
    details: () => details,
    error: () => null,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    apply: async (command) => {
      if (fail) throw new Error("boom");
      applied.push(command);
      return { seq: 1, origin: "apply", changes: [], asset_ids: [] };
    },
    annotationsPage: async () => ({
      rows: [
        ann("c1", "core/classification", "l1"),
        ann("x1", "com.example.shape/shape"),
      ],
      next: null,
    }),
  };
  const open = (assetId: string) => {
    details = detailsOf(assetId);
    current.open({ assetId, itemKey: null, mediaType: "x/image" });
    for (const l of listeners) l();
  };
  const root = document.createElement("div");
  document.body.append(root);
  const notify: PropertiesProps["notify"] = (_level, text) => {
    notes.push(text);
  };
  dispose = render(
    () => (
      <Properties
        data={data}
        current={current}
        drafts={drafts}
        selection={selection}
        supported={() => new Set<string>()}
        notify={notify}
        selectedLabels={() => active}
        onClassify={() => {
          classified.push("classify");
        }}
      />
    ),
    root,
  );
  return { root, open, applied, notes, drafts, selection, classified };
}

describe("Properties（プロパティパネル）", () => {
  it("何も開いていなければ、案内を出す", () => {
    const { root } = mount();
    expect(root.textContent).toContain(t("properties.noCurrent"));
  });

  it("アセットの情報・分類・アノテーションの一覧を出し、未対応の種別を示す", async () => {
    const { root, open } = mount();
    open("a1");
    await flush();
    expect(root.textContent).toContain("a1.png");
    expect(root.querySelector(".prop-chips")?.textContent).toContain("cat");
    const items = root.querySelectorAll(".annotation-item");
    expect(items).toHaveLength(2);
    const unsupported = root.querySelector(".annotation-item.unsupported");
    expect(unsupported?.textContent).toContain("com.example.shape/shape");
  });

  it("作業状態を変えると、set_asset_status が渡る", async () => {
    const { root, open, applied } = mount();
    open("a1");
    await flush();
    const select = root.querySelector(".prop-grid select") as HTMLSelectElement;
    select.value = "done";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(applied).toEqual([
      { kind: "set_asset_status", asset_id: "a1", status: "done" },
    ]);
  });

  it("メモを入力して離れると、set_asset_note が渡る", async () => {
    const { root, open, applied } = mount();
    open("a1");
    await flush();
    const area = root.querySelector("textarea") as HTMLTextAreaElement;
    area.value = "メモ";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    area.dispatchEvent(new Event("blur"));
    await flush();
    expect(applied).toEqual([
      { kind: "set_asset_note", asset_id: "a1", note: "メモ" },
    ]);
  });

  it("入力途中で別のアセットに移ると、保留の確認を出し、確定すると元のアセットに書く", async () => {
    const { root, open, applied } = mount();
    open("a1");
    await flush();
    const area = root.querySelector("textarea") as HTMLTextAreaElement;
    area.value = "途中";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    open("a2");
    await flush();
    expect(root.querySelector(".draft-banner")).not.toBeNull();
    (root.querySelector(".draft-banner .primary") as HTMLButtonElement).click();
    await flush();
    expect(applied).toEqual([
      { kind: "set_asset_note", asset_id: "a1", note: "途中" },
    ]);
    expect(root.querySelector(".draft-banner")).toBeNull();
  });

  it("ラベルの変更と削除が、命令になる（未対応の種別でもできる）", async () => {
    const { root, open, applied } = mount();
    open("a1");
    await flush();
    const item = root.querySelector(
      ".annotation-item.unsupported",
    ) as HTMLElement;
    const select = item.querySelector("select") as HTMLSelectElement;
    select.value = "l1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    (item.querySelector("button") as HTMLButtonElement).click();
    await flush();
    expect(applied).toEqual([
      {
        kind: "update_annotation",
        id: "x1",
        patch: { label_id: { kind: "set", value: "l1" } },
      },
      { kind: "delete_annotation", id: "x1" },
    ]);
  });

  it("書き込みに失敗したら、エラーを知らせる", async () => {
    const { root, open, notes } = mount(true);
    open("a1");
    await flush();
    const select = root.querySelector(".prop-grid select") as HTMLSelectElement;
    select.value = "done";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(notes).toHaveLength(1);
  });

  it("クリックで選択し、Ctrl で足す", async () => {
    const { root, open, selection } = mount();
    open("a1");
    await flush();
    const items = root.querySelectorAll<HTMLElement>(".annotation-item");
    items[0]?.click();
    items[1]?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, ctrlKey: true }),
    );
    expect([...selection.ids()].sort()).toEqual(["c1", "x1"]);
  });

  it("分類のボタン: ラベルを選んでいなければ、案内の文字で押せない", async () => {
    const { root, open } = mount();
    open("a1");
    await flush();
    const button = root.querySelector<HTMLButtonElement>(".classify-button");
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe(t("labels.classify.select"));
  });

  it("分類のボタン: 選んだラベルが付いていれば「外す」。押すと、分類の付け外しを頼む", async () => {
    // 詳細（detailsOf）の分類には、ラベル l1（cat）が付いている
    const attached = mount(false, [label]);
    attached.open("a1");
    await flush();
    const detach =
      attached.root.querySelector<HTMLButtonElement>(".classify-button");
    expect(detach?.disabled).toBe(false);
    expect(detach?.textContent).toBe(
      t("labels.classify.detach").replace("{name}", "cat"),
    );
    detach?.click();
    expect(attached.classified).toEqual(["classify"]);
  });

  it("分類のボタン: 別のラベルを選んでいれば「付ける」", async () => {
    const other = { ...label, id: "l9", name: "dog" };
    const t2 = mount(false, [other]);
    t2.open("a1");
    await flush();
    expect(t2.root.querySelector(".classify-button")?.textContent).toBe(
      t("labels.classify.attach").replace("{name}", "dog"),
    );
  });

  it("分類のボタン（複数選択）: すべて付いていれば「N 件を外す」、付いていないものがあれば「N 件を付ける」", async () => {
    const other = { ...label, id: "l9", name: "dog" };
    const some = mount(false, [label, other]);
    some.open("a1");
    await flush();
    expect(some.root.querySelector(".classify-button")?.textContent).toBe(
      t("labels.classify.attachMany").replace("{count}", "2"),
    );
    dispose?.();
    document.body.innerHTML = "";
    // 詳細の分類に、l1 しか付いていないので、l1 だけを選んでいる場合は「外す」
    const all = mount(false, [label, { ...label }]);
    all.open("a1");
    await flush();
    expect(all.root.querySelector(".classify-button")?.textContent).toBe(
      t("labels.classify.detachMany").replace("{count}", "2"),
    );
  });
});
