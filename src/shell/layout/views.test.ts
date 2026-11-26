import { describe, expect, it, vi } from "vitest";
import { makeProblemSink } from "../testing/fakes";
import { createContext } from "../when/context";
import { createViewRegistry } from "./views";

const render = () => null as never;

function setup() {
  const ctx = createContext();
  const { sink, problems } = makeProblemSink();
  return { ctx, problems, registry: createViewRegistry(ctx, sink) };
}

describe("ビューの登録簿", () => {
  it("場所ごとに、登録順で返す", () => {
    const { registry } = setup();
    registry.register({
      id: "a",
      title: { ja: "A" },
      location: "primarySidebar",
      render,
      source: "core",
    });
    registry.register({
      id: "b",
      title: { ja: "B" },
      location: "panel",
      render,
      source: "core",
    });
    registry.register({
      id: "c",
      title: { ja: "C" },
      location: "primarySidebar",
      render,
      source: "core",
    });
    expect(registry.list("primarySidebar").map((v) => v.id)).toEqual([
      "a",
      "c",
    ]);
    expect(registry.list("panel").map((v) => v.id)).toEqual(["b"]);
    expect(registry.ids("secondarySidebar")).toEqual([]);
  });

  it("同じ ID を登録し直すと中身が差し替わり、dispose で元に戻る", () => {
    const { registry } = setup();
    const first = () => null as never;
    const second = () => null as never;
    registry.register({
      id: "a",
      title: { ja: "A" },
      location: "primarySidebar",
      render: first,
      source: "core",
    });
    const handle = registry.register({
      id: "a",
      title: { ja: "A" },
      location: "primarySidebar",
      render: second,
      source: "feature",
    });
    expect(registry.get("a")?.render).toBe(second);
    handle.dispose();
    expect(registry.get("a")?.render).toBe(first);
  });

  it("when が偽のビューは返さない", () => {
    const { registry, ctx } = setup();
    registry.register({
      id: "a",
      title: { ja: "A" },
      location: "panel",
      when: "projectOpen",
      render,
      source: "x",
    });
    expect(registry.list("panel")).toEqual([]);
    ctx.set("projectOpen", true);
    expect(registry.list("panel")).toHaveLength(1);
  });

  it("unregister(source) で、その追加元のビューが消え、購読者に知らせる", () => {
    const { registry } = setup();
    registry.register({
      id: "a",
      title: { ja: "A" },
      location: "panel",
      render,
      source: "com.x",
    });
    registry.register({
      id: "b",
      title: { ja: "B" },
      location: "panel",
      render,
      source: "core",
    });
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.unregister("com.x");
    expect(registry.list("panel").map((v) => v.id)).toEqual(["b"]);
    expect(listener).toHaveBeenCalled();
  });
});
