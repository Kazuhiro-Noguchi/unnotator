import { describe, expect, it } from "vitest";
import {
  clearFilter,
  EMPTY_FILTER,
  isEmptyFilter,
  normalizeFilter,
  setMissing,
  setName,
  toggleMedia,
  toggleStatus,
} from "./filter";

describe("フィルター条件", () => {
  it("初期値は条件なし", () => {
    expect(isEmptyFilter(EMPTY_FILTER)).toBe(true);
  });

  it("名前は前後の空白を除き、空白だけなら条件なし", () => {
    expect(normalizeFilter({ name: "  img " }).name).toBe("img");
    expect(normalizeFilter({ name: "   " }).name).toBeNull();
    expect(isEmptyFilter(setName(EMPTY_FILTER, "  "))).toBe(true);
    expect(isEmptyFilter(setName(EMPTY_FILTER, "a"))).toBe(false);
  });

  it("状態と媒体種別は、重複を除く。空の配列は条件なし", () => {
    const f = normalizeFilter({
      statuses: ["todo", "todo", "done"],
      media_types: [
        { kind: "is", value: "x/y" },
        { kind: "is", value: "x/y" },
        { kind: "unknown" },
        { kind: "unknown" },
      ],
    });
    expect(f.statuses).toEqual(["todo", "done"]);
    expect(f.media_types).toEqual([
      { kind: "is", value: "x/y" },
      { kind: "unknown" },
    ]);
    expect(isEmptyFilter(normalizeFilter({ statuses: [] }))).toBe(true);
  });

  it("toggleStatus は、あれば外し、無ければ足す", () => {
    const on = toggleStatus(EMPTY_FILTER, "todo");
    expect(on.statuses).toEqual(["todo"]);
    expect(toggleStatus(on, "todo").statuses).toEqual([]);
    expect(toggleStatus(on, "done").statuses).toEqual(["todo", "done"]);
  });

  it("toggleMedia は、ID と「不明」を同じ規則で切り替える", () => {
    const on = toggleMedia(EMPTY_FILTER, { kind: "unknown" });
    expect(on.media_types).toEqual([{ kind: "unknown" }]);
    expect(toggleMedia(on, { kind: "unknown" }).media_types).toEqual([]);
    const both = toggleMedia(on, { kind: "is", value: "a/b" });
    expect(both.media_types.length).toBe(2);
    expect(toggleMedia(both, { kind: "is", value: "a/b" }).media_types).toEqual(
      [{ kind: "unknown" }],
    );
  });

  it("リンク切れは、だけ・無いもの・指定なしの 3 つ", () => {
    expect(setMissing(EMPTY_FILTER, true).missing).toBe(true);
    expect(setMissing(EMPTY_FILTER, false).missing).toBe(false);
    expect(isEmptyFilter(setMissing(EMPTY_FILTER, false))).toBe(false);
    expect(
      isEmptyFilter(setMissing(setMissing(EMPTY_FILTER, true), null)),
    ).toBe(true);
  });

  it("一括解除で、すべての条件が消える", () => {
    const busy = setMissing(
      toggleStatus(setName(EMPTY_FILTER, "x"), "review"),
      true,
    );
    expect(isEmptyFilter(busy)).toBe(false);
    expect(clearFilter()).toEqual(EMPTY_FILTER);
  });

  it("元の値を書き換えない", () => {
    const base = setName(EMPTY_FILTER, "a");
    toggleStatus(base, "todo");
    expect(base.statuses).toEqual([]);
    expect(EMPTY_FILTER.name).toBeNull();
  });
});
