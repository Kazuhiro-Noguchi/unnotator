import { describe, expect, it, vi } from "vitest";
import { createApiBroker } from "./api-proxy";
import type { Ctx } from "./host-api/api-types";

function manifests(deps: Record<string, string[]>) {
  const get = (id: string) =>
    id in deps ? ({ id, extensionDependencies: deps[id] } as never) : undefined;
  return { get, all: () => Object.keys(deps).map((id) => get(id) as never) };
}

function setup(options: {
  deps?: Record<string, string[]>;
  running?: boolean;
  reply?: unknown;
}) {
  const call = vi.fn(async (_m: string, _a: unknown) => options.reply ?? 42);
  const broker = createApiBroker({
    manifests: manifests(
      options.deps ?? { "a.rect": ["a.base"], "a.base": [], "a.other": [] },
    ),
    background: async () => (options.running === false ? undefined : { call }),
  });
  const run = (extId: string, args: unknown) =>
    (
      broker.handlers["extensions.getApi"] as (
        c: Ctx,
        a: unknown,
      ) => Promise<unknown>
    )({ extId } as Ctx, args);
  return { run, call, broker };
}

describe("getApi の仲介（research.md R4）", () => {
  it("依存先が公開した関数の名前の表を返す", async () => {
    const t = setup({});
    await t.run("a.base", { publish: ["answer", "nested.name"] });
    await expect(t.run("a.rect", { id: "a.base" })).resolves.toEqual([
      "answer",
      "nested.name",
    ]);
  });

  it("依存を宣言していない拡張機能は PermissionDenied", async () => {
    const t = setup({});
    await t.run("a.base", { publish: ["answer"] });
    await expect(t.run("a.other", { id: "a.base" })).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    await expect(
      t.run("a.other", { id: "a.base", call: "answer", args: [] }),
    ).rejects.toMatchObject({ code: "PermissionDenied" });
    expect(t.call).not.toHaveBeenCalled();
  });

  it("呼び出しは、依存先の裏の枠へ invoke(kind=api) で渡る", async () => {
    const t = setup({ reply: { ok: 1 } });
    await t.run("a.base", { publish: ["nested.name"] });
    const result = await t.run("a.rect", {
      id: "a.base",
      call: "nested.name",
      args: ["x", 2],
    });
    expect(result).toEqual({ ok: 1 });
    expect(t.call).toHaveBeenCalledWith("invoke", {
      kind: "api",
      localId: "",
      member: "nested.name",
      args: ["x", 2],
    });
  });

  it("公開していない名前は呼べない（NotFound）", async () => {
    const t = setup({});
    await t.run("a.base", { publish: ["answer"] });
    await expect(
      t.run("a.rect", { id: "a.base", call: "secret", args: [] }),
    ).rejects.toMatchObject({ code: "NotFound" });
    expect(t.call).not.toHaveBeenCalled();
  });

  it("引数が構造化複製できない値なら ValidationFailed（呼ばない）", async () => {
    const t = setup({});
    await t.run("a.base", { publish: ["answer"] });
    await expect(
      t.run("a.rect", { id: "a.base", call: "answer", args: [() => 1] }),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(t.call).not.toHaveBeenCalled();
  });

  it("戻り値が構造化複製できない値なら ValidationFailed", async () => {
    const t = setup({ reply: { fn: () => 1 } });
    await t.run("a.base", { publish: ["answer"] });
    await expect(
      t.run("a.rect", { id: "a.base", call: "answer", args: [] }),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it("依存先が無効・失敗で動かせないなら、失敗として返る（NotFound）", async () => {
    const t = setup({ running: false });
    await t.run("a.base", { publish: ["answer"] });
    await expect(t.run("a.rect", { id: "a.base" })).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  it("依存先の応答のエラーの code は、そのまま返す", async () => {
    const t = setup({});
    await t.run("a.base", { publish: ["answer"] });
    t.call.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "PermissionDenied" }),
    );
    await expect(
      t.run("a.rect", { id: "a.base", call: "answer", args: [] }),
    ).rejects.toMatchObject({ code: "PermissionDenied" });
  });

  it("不正な publish（名前の形・数）は拒否する", async () => {
    const t = setup({});
    await expect(
      t.run("a.base", { publish: ["bad name"] }),
    ).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    await expect(
      t.run("a.base", {
        publish: Array.from({ length: 2000 }, (_, i) => `f${i}`),
      }),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(t.run("a.base", "nope")).rejects.toMatchObject({
      code: "ValidationFailed",
    });
  });

  it("公開した表は、forget で消える（拡張機能を止めたとき）", async () => {
    const t = setup({});
    await t.run("a.base", { publish: ["answer"] });
    t.broker.forget("a.base");
    await expect(t.run("a.rect", { id: "a.base" })).resolves.toEqual([]);
  });
});
