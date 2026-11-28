import { describe, expect, it, vi } from "vitest";
import { createMirrorFeed } from "./mirror-feed";
import { createHostState } from "./state";

const label = { id: "l1", name: "cat" };
const target = { assetId: "a1" };

function setup(granted: string[] = []) {
  const state = createHostState({
    selection: ["n1"],
    "labels.active": label,
    "assets.current": target,
    "tools.active": "com.example.a/pen",
    settings: { "a.size": 3, "a.hidden": 1, "b.other": 2 },
  });
  const feed = createMirrorFeed({
    state,
    allowed: async (_id, permission) => granted.includes(permission),
    declaredSettings: (id) => (id === "com.example.a" ? ["a.size"] : []),
  });
  return { state, feed };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("写しの最初の値（snapshot）", () => {
  it("権限の要らない値は常に入り、要るものは権限があるときだけ入る", async () => {
    const none = await setup().feed.snapshot("com.example.a");
    expect(none).toEqual({
      selection: ["n1"],
      "labels.active": null,
      "assets.current": null,
      "tools.active": "com.example.a/pen",
      settings: { "a.size": 3 },
    });
    const all = await setup(["labels.read", "assets.read"]).feed.snapshot(
      "com.example.a",
    );
    expect(all["labels.active"]).toEqual(label);
    expect(all["assets.current"]).toEqual(target);
  });

  it("settings は、マニフェストで宣言したキーだけ（宣言が無ければ空）", async () => {
    const { feed } = setup();
    expect((await feed.snapshot("com.example.b")).settings).toEqual({});
  });
});

describe("差分の押し込み（attach）", () => {
  it("状態が変わるたびに、キーごとの ev を押し込む", async () => {
    const { state, feed } = setup(["labels.read"]);
    const emit = vi.fn();
    feed.attach("com.example.a", emit);
    state.set("selection", ["n2", "n3"]);
    state.set("tools.active", null);
    state.set("labels.active", { id: "l2" });
    await tick();
    expect(emit).toHaveBeenCalledWith("selection", ["n2", "n3"]);
    expect(emit).toHaveBeenCalledWith("tools.active", null);
    expect(emit).toHaveBeenCalledWith("labels.active", { id: "l2" });
  });

  it("権限の無い値の差分は、押し込まない", async () => {
    const { state, feed } = setup([]);
    const emit = vi.fn();
    feed.attach("com.example.a", emit);
    state.set("labels.active", { id: "l2" });
    state.set("assets.current", { assetId: "a9" });
    await tick();
    expect(emit).not.toHaveBeenCalled();
  });

  it("settings は、宣言したキーだけにして押し込む。宣言したキーが変わらなければ押し込まない", async () => {
    const { state, feed } = setup();
    const emit = vi.fn();
    feed.attach("com.example.a", emit);
    state.set("settings", { "a.size": 3, "a.hidden": 9, "b.other": 2 });
    await tick();
    expect(emit).not.toHaveBeenCalled();
    state.set("settings", { "a.size": 4, "a.hidden": 9 });
    await tick();
    expect(emit).toHaveBeenCalledWith("settings", { "a.size": 4 });
  });

  it("detach すると、以後は押し込まない（枠を取り除いたとき）", async () => {
    const { state, feed } = setup();
    const emit = vi.fn();
    const detach = feed.attach("com.example.a", emit);
    detach();
    state.set("selection", ["x"]);
    await tick();
    expect(emit).not.toHaveBeenCalled();
  });

  it("枠ごとに独立している", async () => {
    const { state, feed } = setup();
    const one = vi.fn();
    const two = vi.fn();
    feed.attach("com.example.a", one);
    const detach = feed.attach("com.example.a", two);
    detach();
    state.set("selection", ["x"]);
    await tick();
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).not.toHaveBeenCalled();
  });
});
