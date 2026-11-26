import { describe, expect, it } from "vitest";
import { createCurrentStore } from "./current";

describe("CurrentStore", () => {
  it("最初は何も開いていない", () => {
    expect(createCurrentStore().get()).toBeNull();
  });

  it("open で現在位置が変わり、購読者に知らせる", () => {
    const store = createCurrentStore();
    const seen: Array<unknown> = [];
    store.subscribe(() => seen.push(store.get()));
    store.open({ assetId: "a1", itemKey: null });
    store.open({ assetId: "a1", itemKey: "page:2" });
    expect(seen).toEqual([
      { assetId: "a1", itemKey: null },
      { assetId: "a1", itemKey: "page:2" },
    ]);
  });

  it("同じ位置を開き直しても、知らせない", () => {
    const store = createCurrentStore();
    let count = 0;
    store.subscribe(() => {
      count += 1;
    });
    store.open({ assetId: "a1", itemKey: null });
    store.open({ assetId: "a1", itemKey: null });
    expect(count).toBe(1);
  });

  it("clear で null に戻り、何も開いていないときの clear は知らせない", () => {
    const store = createCurrentStore();
    let count = 0;
    store.subscribe(() => {
      count += 1;
    });
    store.clear();
    expect(count).toBe(0);
    store.open({ assetId: "a1", itemKey: null });
    store.clear();
    expect(store.get()).toBeNull();
    expect(count).toBe(2);
  });

  it("購読を解除すると、知らせない", () => {
    const store = createCurrentStore();
    let count = 0;
    const off = store.subscribe(() => {
      count += 1;
    });
    off();
    store.open({ assetId: "a1", itemKey: null });
    expect(count).toBe(0);
  });

  it("渡した位置を後から書き換えても、保持している値は変わらない", () => {
    const store = createCurrentStore();
    const target = { assetId: "a1", itemKey: null as string | null };
    store.open(target);
    target.assetId = "other";
    expect(store.get()?.assetId).toBe("a1");
  });
});
