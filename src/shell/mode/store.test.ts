import { describe, expect, it } from "vitest";
import { createModeStore } from "./store";

function setup() {
  const context = new Map<string, unknown>();
  const store = createModeStore({
    set: (key, value) => void context.set(key, value),
  });
  return { store, context };
}

describe("ModeStore（リボンの「モード」）", () => {
  it("最初は、どのモードでもない。コンテキストにも、それが出る", () => {
    const { store, context } = setup();
    expect(store.get()).toBeNull();
    expect(context.get("mode")).toBeNull();
    expect(context.get("modeFileClassification")).toBe(false);
  });

  it("モードを入れると、コンテキストに反映される。もう一度で、切る（toggle）", () => {
    const { store, context } = setup();
    store.toggle("fileClassification");
    expect(store.get()).toBe("fileClassification");
    expect(context.get("mode")).toBe("fileClassification");
    expect(context.get("modeFileClassification")).toBe(true);
    store.toggle("fileClassification");
    expect(store.get()).toBeNull();
    expect(context.get("modeFileClassification")).toBe(false);
  });

  it("set は、直接切り替える。変わったときだけ、購読者に知らせる", () => {
    const { store } = setup();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.set("fileClassification");
    store.set("fileClassification");
    store.set(null);
    expect(calls).toBe(2);
  });
});
