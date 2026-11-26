import { describe, expect, it } from "vitest";
import { allTitles, resolveTitle } from "./title";

describe("表示名の解決", () => {
  it("指定の言語を使い、無ければもう一方にする", () => {
    expect(resolveTitle({ ja: "保存", en: "Save" }, "en")).toBe("Save");
    expect(resolveTitle({ ja: "保存" }, "en")).toBe("保存");
    expect(resolveTitle({ en: "Save" }, "ja")).toBe("Save");
    expect(resolveTitle({}, "ja")).toBe("");
  });

  it("i18n の鍵も解決できる", () => {
    expect(resolveTitle({ key: "view.explorer.title" }, "en")).toBe("Explorer");
    expect(resolveTitle({ key: "view.explorer.title" }, "ja")).toBe(
      "エクスプローラー",
    );
  });

  it("検索用に両言語の名前を返す", () => {
    expect(allTitles({ ja: "保存", en: "Save" })).toEqual(["保存", "Save"]);
    expect(allTitles({ ja: "同じ", en: "同じ" })).toEqual(["同じ"]);
    expect(allTitles({ ja: "保存" })).toEqual(["保存"]);
  });
});
