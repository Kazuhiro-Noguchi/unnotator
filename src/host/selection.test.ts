import { describe, expect, it, vi } from "vitest";
import { createSelection } from "../shell/properties/selection";
import { createHostState } from "./host-api/state";
import { setup } from "./host-api/test-support";
import { createHostSelection } from "./selection";

function make(existing: string[] = ["a", "b", "c"]) {
  const selection = createSelection();
  const state = createHostState();
  const exists = vi.fn(
    async (ids: string[]) =>
      new Set(ids.filter((id) => existing.includes(id))) as ReadonlySet<string>,
  );
  const host = createHostSelection({ selection, state, exists });
  return { selection, state, exists, host };
}

describe("ホストの選択（FR-024）", () => {
  it("シェルの選択（プロパティパネル・エディター）が変わると、写しの元（selection）にも反映される", () => {
    const { selection, state } = make();
    selection.select("a", false);
    selection.select("b", true);
    expect(state.get("selection")).toEqual(["a", "b"]);
    selection.clear();
    expect(state.get("selection")).toEqual([]);
  });

  it("最初から選んであるものも、結んだ時点で写しの元に入る", () => {
    const selection = createSelection();
    selection.select("a", false);
    const state = createHostState();
    createHostSelection({
      selection,
      state,
      exists: async (ids) => new Set(ids),
    });
    expect(state.get("selection")).toEqual(["a"]);
  });

  it("拡張機能からの set は、シェルの選択（1 か所）を更新する", async () => {
    const { selection, state, host } = make();
    await host.set(["b", "c"]);
    expect([...selection.ids()]).toEqual(["b", "c"]);
    expect(state.get("selection")).toEqual(["b", "c"]);
  });

  it("存在しない ID は取り除く。重複も 1 つにする", async () => {
    const { selection, state, host } = make();
    await host.set(["a", "zzz", "a", "b"]);
    expect([...selection.ids()]).toEqual(["a", "b"]);
    expect(state.get("selection")).toEqual(["a", "b"]);
  });

  it("枠の楽観の更新と食い違ったときは、結果が変わらなくても写しを必ず送り直す（ホストが正）", async () => {
    const { state, host } = make();
    const seen: unknown[] = [];
    state.subscribe("selection", (v) => seen.push(v));
    // 枠は ["zzz"] と楽観で書いたが、ホストの選択は空のまま。
    await host.set(["zzz"]);
    expect(seen).toEqual([[]]);
  });

  it("空の選択を set すると、選択が空になる", async () => {
    const { selection, host } = make();
    await host.set(["a"]);
    await host.set([]);
    expect(selection.ids().size).toBe(0);
  });

  it("重ねて呼ばれても、呼ばれた順に反映される（後の呼び出しが勝つ）", async () => {
    const selection = createSelection();
    const state = createHostState();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const host = createHostSelection({
      selection,
      state,
      exists: async (ids) => {
        if (first) {
          first = false;
          await gate; // 最初の問い合わせだけ遅い
        }
        return new Set(ids);
      },
    });
    const p1 = host.set(["a"]);
    const p2 = host.set(["b"]);
    release();
    await Promise.all([p1, p2]);
    expect([...selection.ids()]).toEqual(["b"]);
  });

  it("消えたアノテーションを選択から外す（retain）と、写しにも反映される", () => {
    const { selection, state } = make();
    selection.select("a", false);
    selection.select("b", true);
    selection.retain(new Set(["a"]));
    expect(state.get("selection")).toEqual(["a"]);
  });

  it("解除すると、以後のシェルの変更は写しに反映されない", () => {
    const { selection, state, host } = make();
    host.dispose();
    selection.select("a", false);
    expect(state.get("selection")).toEqual([]);
  });
});

describe("selection.set の Host API", () => {
  it("ホストの選択へ渡す。権限は要らない", async () => {
    const set = vi.fn(async () => {});
    const { call } = setup({ selection: { set } });
    await call("selection.set", [["a", "b"]]);
    expect(set).toHaveBeenCalledWith(["a", "b"]);
  });

  it("文字列の配列でなければ ValidationFailed", async () => {
    const set = vi.fn(async () => {});
    const { call } = setup({ selection: { set } });
    await expect(call("selection.set", [["a", 1]])).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    await expect(call("selection.set", ["a"])).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    expect(set).not.toHaveBeenCalled();
  });

  it("多すぎる ID は ValidationFailed", async () => {
    const set = vi.fn(async () => {});
    const { call } = setup({ selection: { set } });
    const many = Array.from({ length: 10_001 }, (_, i) => `id${i}`);
    await expect(call("selection.set", [many])).rejects.toMatchObject({
      code: "ValidationFailed",
    });
  });
});
