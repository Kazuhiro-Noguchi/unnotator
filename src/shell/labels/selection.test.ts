import { describe, expect, it } from "vitest";
import { applyClick, EMPTY_SELECTION, pruneSelection } from "./selection";

const order = ["a", "b", "c", "d", "e"];
const sel = (ids: string[], anchor: string | null = ids.at(-1) ?? null) => ({
  ids,
  anchor,
});

describe("applyClick（ラベルの選択）", () => {
  it("通常のクリック: そのラベルだけを選ぶ。選択中の 1 つだけを押すと、解除する", () => {
    expect(applyClick(EMPTY_SELECTION, "b", "replace", order)).toEqual(
      sel(["b"]),
    );
    expect(applyClick(sel(["a", "c"]), "b", "replace", order)).toEqual(
      sel(["b"]),
    );
    expect(applyClick(sel(["b"]), "b", "replace", order)).toEqual(
      EMPTY_SELECTION,
    );
    // 複数選択中に、その 1 つを押したときは、その 1 つだけにする
    expect(applyClick(sel(["a", "b"]), "b", "replace", order)).toEqual(
      sel(["b"]),
    );
  });

  it("Ctrl / Cmd クリック: 選択に足す・外す（最後に押したものが、主なラベル）", () => {
    let s = applyClick(EMPTY_SELECTION, "a", "toggle", order);
    s = applyClick(s, "c", "toggle", order);
    expect(s).toEqual(sel(["a", "c"], "c"));
    s = applyClick(s, "a", "toggle", order);
    expect(s).toEqual(sel(["c"], "a"));
  });

  it("Shift クリック: 起点から、押したものまでの範囲を選ぶ（上へも下へも）", () => {
    const start = applyClick(EMPTY_SELECTION, "b", "replace", order);
    expect(applyClick(start, "d", "range", order)).toEqual({
      ids: ["b", "c", "d"],
      anchor: "b",
    });
    expect(applyClick(start, "a", "range", order)).toEqual({
      ids: ["b", "a"],
      anchor: "b",
    });
  });

  it("Shift クリックで、起点が無ければ、押したものを選ぶ。起点が並びに無いときも、同じ", () => {
    expect(applyClick(EMPTY_SELECTION, "c", "range", order)).toEqual(
      sel(["c"]),
    );
    expect(applyClick(sel(["zzz"], "zzz"), "c", "range", order)).toEqual(
      sel(["c"]),
    );
  });
});

describe("pruneSelection", () => {
  it("消えたもの・使えないものを、選択から外す。変わらなければ、同じものを返す", () => {
    const s = sel(["a", "b", "c"], "b");
    expect(pruneSelection(s, new Set(["a", "c"]))).toEqual({
      ids: ["a", "c"],
      anchor: null,
    });
    expect(pruneSelection(s, new Set(["a", "b", "c", "d"]))).toBe(s);
  });
});
