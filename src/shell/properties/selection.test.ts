import { describe, expect, it } from "vitest";
import { createSelection } from "./selection";

describe("Selection", () => {
  it("通常の選択は、1 つだけ。multi では足し引きする", () => {
    const s = createSelection();
    s.select("a", false);
    s.select("b", true);
    expect([...s.ids()]).toEqual(["a", "b"]);
    s.select("a", true);
    expect([...s.ids()]).toEqual(["b"]);
    s.select("c", false);
    expect([...s.ids()]).toEqual(["c"]);
  });

  it("消えた ID は、選択から外れる。変わらなければ知らせない", () => {
    const s = createSelection();
    let n = 0;
    s.subscribe(() => {
      n += 1;
    });
    s.select("a", false);
    s.select("b", true);
    n = 0;
    s.retain(new Set(["a", "b"]));
    expect(n).toBe(0);
    s.retain(new Set(["a"]));
    expect([...s.ids()]).toEqual(["a"]);
    expect(n).toBe(1);
    s.clear();
    expect(s.ids().size).toBe(0);
  });
});
