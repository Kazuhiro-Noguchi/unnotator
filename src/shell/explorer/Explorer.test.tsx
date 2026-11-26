// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n";
import { FakeTreeIpc } from "../testing/fakes";
import { createExplorerController } from "./controller";
import { createCurrentStore } from "./current";
import { Explorer } from "./Explorer";
import { createRowsStore } from "./rows";
import type { TreeRow } from "./types";

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

async function mount(rows: TreeRow[] = ROWS) {
  const ipc = new FakeTreeIpc();
  ipc.setRows(rows);
  const store = createRowsStore(ipc);
  const current = createCurrentStore();
  const controller = createExplorerController({ rows: store, current });
  dispose = render(
    () => <Explorer controller={controller} rows={store} current={current} />,
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
    expect(current.get()).toEqual({ assetId: "x1", itemKey: null });
    expect(items()[2]?.getAttribute("aria-selected")).toBe("true");
    expect(items()[3]?.getAttribute("aria-selected")).toBe("false");
  });

  it("クリックでアセットを開く", async () => {
    const { current } = await mount();
    items()[3]?.click();
    await flush();
    expect(current.get()).toEqual({ assetId: "x2", itemKey: null });
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
});
