// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { FakeItemSource } from "../../host/item-source";
import { t } from "../../i18n";
import { FakeTreeIpc } from "../testing/fakes";
import { createExplorerController } from "./controller";
import { createCurrentStore } from "./current";
import { Explorer } from "./Explorer";
import { createItemRows } from "./items";
import { createRowsStore } from "./rows";
import type { TreeFilter, TreeRow } from "./types";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const ROWS: TreeRow[] = [
  {
    kind: "root",
    root_key: "",
    name: "",
    depth: 0,
    expanded: true,
    total: 3,
    done: 1,
  },
  {
    kind: "folder",
    root_key: "",
    path: "a",
    name: "a",
    depth: 1,
    expanded: true,
    total: 2,
    done: 1,
  },
  {
    kind: "asset",
    id: "x1",
    name: "img2.png",
    depth: 2,
    media_type: "t/image",
    status: "done",
    missing: false,
    expanded: false,
    pinned: false,
  },
  {
    kind: "asset",
    id: "x2",
    name: "img10.png",
    depth: 2,
    media_type: null,
    status: "review",
    missing: true,
    expanded: false,
    pinned: false,
  },
  {
    kind: "folder",
    root_key: "",
    path: "b",
    name: "b",
    depth: 1,
    expanded: false,
    total: 1,
    done: 0,
  },
];

async function mount(
  rows: TreeRow[] = ROWS,
  options: { mediaTypes?: string[] } = {},
) {
  const ipc = new FakeTreeIpc();
  ipc.setRows(rows);
  const store = createRowsStore(ipc);
  const current = createCurrentStore();
  const controller = createExplorerController({ rows: store, current });
  dispose = render(
    () => (
      <Explorer
        controller={controller}
        rows={store}
        current={current}
        filterDebounceMs={0}
        mediaTypes={options.mediaTypes ?? []}
      />
    ),
    document.body,
  );
  await controller.start([]);
  await flush();
  const tree = document.querySelector<HTMLElement>('[role="tree"]');
  return { ipc, store, current, controller, tree };
}

function press(element: Element, key: string) {
  element.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

function items() {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')];
}

describe("Explorer（部品）", () => {
  it("行を、名前・状態の印・リンク切れの印・フォルダの集計つきで出す", async () => {
    await mount();
    const texts = items().map((el) => el.textContent ?? "");
    expect(texts.length).toBe(5);
    expect(texts[0]).toContain("1 / 3");
    expect(texts[1]).toContain("a");
    expect(texts[2]).toContain("img2.png");
    const dots = [...document.querySelectorAll<HTMLElement>(".status-dot")];
    expect(dots.map((d) => d.dataset.status)).toEqual(["done", "review"]);
    expect(dots[0]?.getAttribute("aria-label")).toBeTruthy();
    expect(items()[3]?.textContent).toContain(t("explorer.missing"));
    expect(items()[3]?.classList.contains("missing")).toBe(true);
  });

  it("ツリーとして、深さ・開閉・フォーカスの行を伝える", async () => {
    const { tree } = await mount();
    expect(tree?.getAttribute("aria-label")).toBeTruthy();
    expect(tree?.tabIndex).toBe(0);
    const [root, folder, asset, , closed] = items();
    expect(root?.getAttribute("aria-level")).toBe("1");
    expect(asset?.getAttribute("aria-level")).toBe("3");
    expect(folder?.getAttribute("aria-expanded")).toBe("true");
    expect(closed?.getAttribute("aria-expanded")).toBe("false");
    expect(asset?.getAttribute("aria-expanded")).toBeNull();
    expect(tree?.getAttribute("aria-activedescendant")).toBe("explorer-row-0");
  });

  it("上下・Home・End でフォーカスが動く", async () => {
    const { tree } = await mount();
    if (!tree) throw new Error("tree が無い");
    press(tree, "ArrowDown");
    press(tree, "ArrowDown");
    await flush();
    expect(tree.getAttribute("aria-activedescendant")).toBe("explorer-row-2");
    press(tree, "End");
    await flush();
    expect(tree.getAttribute("aria-activedescendant")).toBe("explorer-row-4");
    press(tree, "Home");
    await flush();
    expect(tree.getAttribute("aria-activedescendant")).toBe("explorer-row-0");
    press(tree, "ArrowUp");
    await flush();
    expect(tree.getAttribute("aria-activedescendant")).toBe("explorer-row-0");
  });

  it("Enter でアセットを開き、選択の印が付く", async () => {
    const { tree, current } = await mount();
    if (!tree) throw new Error("tree が無い");
    press(tree, "ArrowDown");
    press(tree, "ArrowDown");
    press(tree, "Enter");
    await flush();
    expect(current.get()).toEqual({
      assetId: "x1",
      itemKey: null,
      mediaType: "t/image",
    });
    expect(items()[2]?.getAttribute("aria-selected")).toBe("true");
    expect(items()[3]?.getAttribute("aria-selected")).toBe("false");
  });

  it("クリックでアセットを開く", async () => {
    const { current } = await mount();
    items()[3]?.click();
    await flush();
    expect(current.get()).toEqual({
      assetId: "x2",
      itemKey: null,
      mediaType: null,
    });
  });

  it("左右でフォルダを開閉し、見え方に反映する", async () => {
    const { tree, ipc } = await mount();
    if (!tree) throw new Error("tree が無い");
    // b（閉じている）へ移って、右で開く
    press(tree, "End");
    press(tree, "ArrowRight");
    await flush();
    const last = ipc.viewCalls.at(-1);
    expect(last?.expanded_folders).toContainEqual({ root_key: "", path: "b" });
    // 開いているフォルダ a で左を押すと閉じる
    press(tree, "Home");
    press(tree, "ArrowDown");
    press(tree, "ArrowLeft");
    await flush();
    const after = ipc.viewCalls.at(-1);
    expect(after?.expanded_folders).not.toContainEqual({
      root_key: "",
      path: "a",
    });
  });

  it("左で、開いていない行は親へ移る", async () => {
    const { tree } = await mount();
    if (!tree) throw new Error("tree が無い");
    press(tree, "ArrowDown");
    press(tree, "ArrowDown"); // img2.png（深さ 2）
    press(tree, "ArrowLeft");
    await flush();
    expect(tree.getAttribute("aria-activedescendant")).toBe("explorer-row-1");
  });

  it("先頭の文字で、その名前の行へ移る", async () => {
    const { tree } = await mount();
    if (!tree) throw new Error("tree が無い");
    press(tree, "b");
    await flush();
    expect(tree.getAttribute("aria-activedescendant")).toBe("explorer-row-4");
  });

  it("アセットが 0 件なら、空の状態の案内を出す", async () => {
    await mount([]);
    expect(document.querySelector('[role="tree"]')).toBeNull();
    expect(document.querySelector(".empty-state")?.textContent).toContain(
      t("explorer.empty.noAssets"),
    );
  });

  describe("フィルター", () => {
    const lastFilter = (ipc: FakeTreeIpc): TreeFilter | undefined => {
      const filter = ipc.viewCalls.at(-1)?.filter;
      return filter as TreeFilter | undefined;
    };

    it("名前を入れると、その条件で見え方を設定し直す", async () => {
      const { ipc } = await mount();
      const input = document.querySelector<HTMLInputElement>(
        'input[type="search"]',
      );
      if (!input) throw new Error("入力欄が無い");
      input.value = "img";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      await flush();
      expect(lastFilter(ipc)?.name).toBe("img");
    });

    it("状態の選択で、状態の条件が切り替わる", async () => {
      const { ipc } = await mount();
      const chip = document.querySelector<HTMLInputElement>(
        'input[data-filter-status="todo"]',
      );
      if (!chip) throw new Error("状態の選択が無い");
      chip.click();
      await flush();
      expect(lastFilter(ipc)?.statuses).toEqual(["todo"]);
      chip.click();
      await flush();
      expect(lastFilter(ipc)?.statuses).toEqual([]);
    });

    it("リンク切れと「不明」の選択も、条件になる", async () => {
      const { ipc } = await mount(ROWS, { mediaTypes: ["t/image"] });
      const select = document.querySelector<HTMLSelectElement>(
        "select[data-filter-missing]",
      );
      if (!select) throw new Error("選択が無い");
      select.value = "only";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      document
        .querySelector<HTMLInputElement>('input[data-filter-media="unknown"]')
        ?.click();
      document
        .querySelector<HTMLInputElement>('input[data-filter-media="t/image"]')
        ?.click();
      await flush();
      expect(lastFilter(ipc)?.missing).toBe(true);
      expect(lastFilter(ipc)?.media_types).toEqual([
        { kind: "unknown" },
        { kind: "is", value: "t/image" },
      ]);
    });

    it("一括解除で、すべての条件が消える", async () => {
      const { ipc } = await mount();
      document
        .querySelector<HTMLInputElement>('input[data-filter-status="done"]')
        ?.click();
      await flush();
      expect(lastFilter(ipc)?.statuses).toEqual(["done"]);
      document
        .querySelector<HTMLButtonElement>("button[data-filter-clear]")
        ?.click();
      await flush();
      expect(lastFilter(ipc)).toMatchObject({
        name: null,
        statuses: [],
        media_types: [],
        missing: null,
      });
    });

    it("一致が無いと、案内と解除の操作を出し、解除すると元に戻る", async () => {
      const { ipc } = await mount();
      document
        .querySelector<HTMLInputElement>('input[data-filter-status="review"]')
        ?.click();
      ipc.setRows([]);
      await flush();
      await flush();
      const empty = document.querySelector(".empty-state");
      expect(empty?.textContent).toContain(t("explorer.empty.noMatch"));
      expect(document.querySelector('[role="tree"]')).toBeNull();
      ipc.setRows(ROWS);
      empty?.querySelector("button")?.click();
      await flush();
      await flush();
      expect(lastFilter(ipc)?.statuses).toEqual([]);
      expect(document.querySelector('[role="tree"]')).not.toBeNull();
    });

    it("条件があるあいだ、開いているアセットを現在位置として残すよう伝える", async () => {
      const { ipc, current } = await mount();
      document
        .querySelector<HTMLInputElement>('input[data-filter-status="todo"]')
        ?.click();
      await flush();
      current.open({ assetId: "x1", itemKey: null, mediaType: null });
      await flush();
      await flush();
      expect(ipc.viewCalls.at(-1)?.pinned).toBe("x1");
    });
  });
});

describe("現在位置が変わったとき", () => {
  it("そのアセットの行へフォーカスを移し、閉じたフォルダを開く（ナビゲーションの追従）", async () => {
    const { ipc, current, tree } = await mount();
    if (!tree) throw new Error("tree が無い");
    ipc.located.set("x9", {
      row: 4,
      ancestors: [
        { root_key: "", path: "" },
        { root_key: "", path: "b" },
      ],
    });
    current.open({ assetId: "x9", itemKey: null, mediaType: null });
    await flush();
    await flush();
    expect(ipc.viewCalls.at(-1)?.expanded_folders).toContainEqual({
      root_key: "",
      path: "b",
    });
    expect(tree.getAttribute("aria-activedescendant")).toBe("explorer-row-4");
  });

  it("知らないアセットなら、何もしない", async () => {
    const { current, tree } = await mount();
    if (!tree) throw new Error("tree が無い");
    current.open({ assetId: "nope", itemKey: null, mediaType: null });
    await flush();
    expect(tree.getAttribute("aria-activedescendant")).toBe("explorer-row-0");
  });
});

describe("アイテムの展開", () => {
  const DOC = "t/doc";
  function docRow(id: string, name: string, expanded: boolean): TreeRow {
    return {
      kind: "asset",
      id,
      name,
      depth: 1,
      media_type: DOC,
      status: "todo",
      missing: false,
      expanded,
      pinned: false,
    };
  }
  const plain: TreeRow = {
    kind: "asset",
    id: "pl",
    name: "plain.txt",
    depth: 1,
    media_type: null,
    status: "todo",
    missing: false,
    expanded: false,
    pinned: false,
  };

  async function mountItems(
    configure: (items: FakeItemSource) => void = () => {},
  ) {
    const items = new FakeItemSource();
    items.declare(DOC, {
      workUnit: "item",
      provider: "t/pages",
      hasItems: true,
    });
    items.setItems("d1", 3, { "item:1": "done" });
    configure(items);
    const ipc = new FakeTreeIpc();
    ipc.rowsFn = (spec) => {
      const open = new Map(
        spec.expanded_assets?.map((e) => [e.asset_id, e.item_total ?? null]) ??
          [],
      );
      const out: TreeRow[] = [
        {
          kind: "root",
          root_key: "",
          name: "",
          depth: 0,
          expanded: true,
          total: 2,
          done: 0,
        },
        docRow("d1", "doc1.doc", open.has("d1")),
      ];
      if (open.has("d1")) {
        const total = open.get("d1");
        if (total === null || total === undefined) {
          out.push({ kind: "item_loading", asset_id: "d1", depth: 2 });
        } else {
          for (let index = 0; index < total; index += 1) {
            out.push({ kind: "item_slot", asset_id: "d1", index, depth: 2 });
          }
        }
      }
      out.push(plain);
      return out;
    };
    const store = createRowsStore(ipc);
    const current = createCurrentStore();
    const itemRows = createItemRows({
      source: items,
      recordedStatuses: async () => [],
    });
    const controller = createExplorerController({
      rows: store,
      current,
      items: itemRows,
      traitsOf: (m) => items.traitsOf(m),
    });
    dispose = render(
      () => (
        <Explorer
          controller={controller}
          rows={store}
          current={current}
          filterDebounceMs={0}
        />
      ),
      document.body,
    );
    await controller.start([]);
    await wait();
    const tree = document.querySelector<HTMLElement>('[role="tree"]');
    if (!tree) throw new Error("tree が無い");
    return { ipc, items, tree, current, controller };
  }

  const wait = async () => {
    for (let i = 0; i < 6; i += 1) await flush();
  };

  it("アイテムのある媒体のアセットにだけ、展開の矢印が出る", async () => {
    await mountItems();
    const rows = items().filter(
      (el) =>
        el.textContent?.includes(".doc") || el.textContent?.includes("plain"),
    );
    expect(rows[0]?.querySelector(".tree-chevron")).not.toBeNull();
    expect(rows[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(rows[1]?.querySelector(".tree-chevron")).toBeNull();
    expect(rows[1]?.getAttribute("aria-expanded")).toBeNull();
  });

  it("右キーで展開すると、アイテムが並び、状態の印が出る", async () => {
    const { tree, ipc } = await mountItems();
    press(tree, "ArrowDown"); // doc1.doc
    press(tree, "ArrowRight");
    await wait();
    expect(
      ipc.viewCalls.some((s) =>
        s.expanded_assets?.some(
          (e) => e.asset_id === "d1" && e.item_total === null,
        ),
      ),
    ).toBe(true);
    expect(ipc.viewCalls.at(-1)?.expanded_assets).toEqual([
      { asset_id: "d1", item_total: 3 },
    ]);
    const names = items().map((el) => el.textContent ?? "");
    expect(names.filter((n) => n.includes("Item "))).toHaveLength(3);
    const dots = [...document.querySelectorAll<HTMLElement>(".status-dot")].map(
      (d) => d.dataset.status,
    );
    expect(dots).toContain("done");
  });

  it("展開しているアセットは、左キーで閉じる（アイテムの取得も捨てる）", async () => {
    const { tree, ipc } = await mountItems();
    press(tree, "ArrowDown");
    press(tree, "ArrowRight");
    await wait();
    press(tree, "ArrowLeft");
    await wait();
    expect(ipc.viewCalls.at(-1)?.expanded_assets).toEqual([]);
    expect(items().some((el) => el.textContent?.includes("Item "))).toBe(false);
  });

  it("アイテム行を選ぶと、アイテムのキーつきで開く", async () => {
    const { tree, current } = await mountItems();
    press(tree, "ArrowDown");
    press(tree, "ArrowRight");
    await wait();
    const second = items().find((el) => el.textContent?.includes("Item 1"));
    second?.click();
    await wait();
    expect(current.get()).toEqual({
      assetId: "d1",
      itemKey: "item:1",
      mediaType: DOC,
    });
  });

  it("提供元が失敗したら、そのアセットの下に案内と再試行を出し、直ったら並ぶ", async () => {
    const { tree, items: source } = await mountItems((s) =>
      s.failWith("d1", "failed"),
    );
    press(tree, "ArrowDown");
    press(tree, "ArrowRight");
    await wait();
    expect(document.body.textContent).toContain(
      t("explorer.item.error.failed"),
    );
    expect(document.querySelector('[role="tree"]')).not.toBeNull();
    source.failWith("d1", null);
    document
      .querySelector<HTMLButtonElement>("button[data-item-retry]")
      ?.click();
    await wait();
    expect(
      items().filter((el) => el.textContent?.includes("Item ")).length,
    ).toBe(3);
  });

  it("提供元が外れていたら、未対応と表示する", async () => {
    const { tree } = await mountItems((s) => s.failWith("d1", "unsupported"));
    press(tree, "ArrowDown");
    press(tree, "ArrowRight");
    await wait();
    expect(document.body.textContent).toContain(t("explorer.item.unsupported"));
  });

  it("アイテムの無い媒体では、右キーで見え方は変わらない", async () => {
    const { tree, ipc } = await mountItems();
    const before = ipc.viewCalls.length;
    press(tree, "End"); // plain.txt
    press(tree, "ArrowRight");
    await wait();
    expect(ipc.viewCalls.length).toBe(before);
  });
});
