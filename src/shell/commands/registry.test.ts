import { describe, expect, it, vi } from "vitest";
import { makeProblemSink } from "../testing/fakes";
import { createContext } from "../when/context";
import { createCommandRegistry } from "./registry";

function setup() {
  const ctx = createContext();
  const { sink, problems } = makeProblemSink();
  const notify = vi.fn();
  const registry = createCommandRegistry({ ctx, report: sink, notify });
  return { ctx, registry, problems, notify };
}

const base = { title: { ja: "テスト", en: "Test" }, source: "core" };

describe("コマンド登録簿", () => {
  it("declare したコマンドを get / list できる", () => {
    const { registry } = setup();
    registry.declare({ id: "core.a", ...base });
    registry.declare({ id: "core.b", ...base });
    expect(registry.get("core.a")?.id).toBe("core.a");
    expect(registry.list().map((c) => c.id)).toEqual(["core.a", "core.b"]);
    expect(registry.get("core.none")).toBeUndefined();
  });

  it("重複した ID は、先のものを残して command.duplicate を報告する", () => {
    const { registry, problems } = setup();
    const first = vi.fn();
    registry.declare({ id: "core.a", ...base, run: first });
    registry.declare({
      id: "core.a",
      ...base,
      title: { ja: "別" },
      run: vi.fn(),
    });
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("core.a")?.title).toEqual(base.title);
    expect(problems.map((p) => p.code)).toEqual(["command.duplicate"]);
  });

  it("run の無いコマンドは未提供で、無効", () => {
    const { registry } = setup();
    registry.declare({ id: "core.a", ...base });
    expect(registry.availability("core.a")()).toEqual({
      enabled: false,
      reason: "unprovided",
    });
  });

  it("provide で処理を結ぶと有効になり、Disposable で外れる", async () => {
    const { registry } = setup();
    registry.declare({ id: "core.a", ...base });
    const run = vi.fn(() => 42);
    const handle = registry.provide("core.a", run);
    expect(registry.availability("core.a")()).toEqual({ enabled: true });
    const result = await registry.execute("core.a", { x: 1 });
    expect(result).toEqual({ ok: true, value: 42 });
    expect(run).toHaveBeenCalledWith({ x: 1 });
    handle.dispose();
    expect(registry.availability("core.a")()).toEqual({
      enabled: false,
      reason: "unprovided",
    });
  });

  it("未登録のコマンドの provide は報告して無視する", () => {
    const { registry, problems } = setup();
    registry.provide("core.none", vi.fn());
    expect(problems.map((p) => p.code)).toEqual(["command.unknown"]);
  });

  it("execute: 未登録は unknown（command.unknown を報告）", async () => {
    const { registry, problems } = setup();
    expect(await registry.execute("core.none")).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(problems.map((p) => p.code)).toEqual(["command.unknown"]);
  });

  it("execute: 処理が無ければ unprovided", async () => {
    const { registry } = setup();
    registry.declare({ id: "core.a", ...base });
    expect(await registry.execute("core.a")).toEqual({
      ok: false,
      reason: "unprovided",
    });
  });

  it("execute: 条件が偽なら実行せず condition", async () => {
    const { registry, ctx } = setup();
    const run = vi.fn();
    registry.declare({ id: "core.a", ...base, enablement: "projectOpen", run });
    expect(await registry.execute("core.a")).toEqual({
      ok: false,
      reason: "condition",
    });
    expect(run).not.toHaveBeenCalled();
    ctx.set("projectOpen", true);
    expect((await registry.execute("core.a")).ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("execute: 非同期の処理の結果を待つ", async () => {
    const { registry } = setup();
    registry.declare({ id: "core.a", ...base, run: async () => "done" });
    expect(await registry.execute("core.a")).toEqual({
      ok: true,
      value: "done",
    });
  });

  it("execute: 例外は隔離し、エラーの通知と command.failed にする", async () => {
    const { registry, problems, notify } = setup();
    registry.declare({
      id: "core.a",
      ...base,
      run: () => {
        throw new Error("boom");
      },
    });
    registry.declare({
      id: "core.b",
      ...base,
      run: async () => {
        throw new Error("async boom");
      },
    });
    expect(await registry.execute("core.a")).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(await registry.execute("core.b")).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]?.[0]).toBe("error");
    expect(problems.map((p) => p.code)).toEqual([
      "command.failed",
      "command.failed",
    ]);
  });

  it("構文エラーの enablement は偽として扱い、when.syntax を報告する", async () => {
    const { registry, problems } = setup();
    registry.declare({
      id: "core.a",
      ...base,
      enablement: "a &&",
      run: vi.fn(),
    });
    expect(registry.availability("core.a")()).toEqual({
      enabled: false,
      reason: "condition",
    });
    expect(problems.some((p) => p.code === "when.syntax")).toBe(true);
  });

  it("unregister(source) で、その追加元のコマンドだけが消える", () => {
    const { registry } = setup();
    registry.declare({ id: "core.a", ...base });
    registry.declare({ id: "com.x/b", ...base, source: "com.x" });
    registry.declare({ id: "com.x/c", ...base, source: "com.x" });
    registry.unregister("com.x");
    expect(registry.list().map((c) => c.id)).toEqual(["core.a"]);
    expect(registry.get("com.x/b")).toBeUndefined();
  });

  it("availability の変化を、コンテキストと登録の変化で watch できる", () => {
    const { registry, ctx } = setup();
    registry.declare({ id: "core.a", ...base, enablement: "projectOpen" });
    const seen: boolean[] = [];
    const w = ctx.watch(
      () => registry.availability("core.a")().enabled,
      (v) => seen.push(v),
    );
    expect(w.value).toBe(false);
    registry.provide("core.a", vi.fn());
    expect(seen).toEqual([]); // 条件がまだ偽
    ctx.set("projectOpen", true);
    expect(seen).toEqual([true]);
    ctx.set("projectOpen", false);
    expect(seen).toEqual([true, false]);
  });
});
