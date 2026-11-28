import { describe, expect, it, vi } from "vitest";
import { createHost } from "../src/host-proxy";
import { createMirror } from "../src/mirror";

function setup(request = vi.fn(async () => null)) {
  const { host } = createHost({
    ext: { id: "com.example.a", version: "1.0.0", path: "" },
    mirror: createMirror({}),
    locale: "ja",
    messages: {},
    base: "unno://localhost",
    request,
    report: vi.fn(),
  });
  return {
    host: host as Record<string, Record<string, (...a: unknown[]) => unknown>>,
    request,
  };
}

describe("annotations.transaction（関数を渡せないので begin / commit / abort に分ける）", () => {
  it("fn が成功したら begin → fn → commit。fn の戻り値を返す", async () => {
    const t = setup();
    const order: string[] = [];
    t.request.mockImplementation(async (m: string, a: unknown) => {
      order.push(`${m}:${(a as { op?: string })?.op ?? ""}`);
      return null;
    });
    const result = await t.host.annotations?.transaction?.(
      "取り込み",
      async () => {
        order.push("fn");
        return 42;
      },
    );
    expect(result).toBe(42);
    expect(order).toEqual([
      "annotations.transaction:begin",
      "fn",
      "annotations.transaction:commit",
    ]);
    expect(t.request.mock.calls[0]?.[1]).toEqual({
      op: "begin",
      label: "取り込み",
    });
  });

  it("fn が失敗したら abort して、そのエラーを投げ直す（commit しない）", async () => {
    const t = setup();
    const ops: string[] = [];
    t.request.mockImplementation(async (_m: string, a: unknown) => {
      ops.push((a as { op: string }).op);
      return null;
    });
    await expect(
      t.host.annotations?.transaction?.("x", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(ops).toEqual(["begin", "abort"]);
  });

  it("commit が失敗したら、そのエラーを返す（abort は送らない。ホストが捨てている）", async () => {
    const ops: string[] = [];
    const request = vi.fn(async (_m: string, a: unknown) => {
      const op = (a as { op: string }).op;
      ops.push(op);
      if (op === "commit")
        throw Object.assign(new Error("bad"), { code: "ValidationFailed" });
      return null;
    });
    const t = setup(request);
    await expect(
      t.host.annotations?.transaction?.("x", async () => 1),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(ops).toEqual(["begin", "commit"]);
  });

  it("begin が失敗したら、fn は呼ばない", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("denied"), { code: "PermissionDenied" });
    });
    const t = setup(request);
    const fn = vi.fn(async () => 1);
    await expect(
      t.host.annotations?.transaction?.("x", fn),
    ).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("register", () => {
  it("localId と、実装の関数メンバーの名前を送る。拒否されたらログに残す", async () => {
    const report = vi.fn();
    const request = vi.fn(async () => {
      throw new Error("not declared");
    });
    const { host } = createHost({
      ext: { id: "com.example.a", version: "1.0.0", path: "" },
      mirror: createMirror({}),
      locale: "ja",
      messages: {},
      base: "unno://localhost",
      request,
      report,
    });
    const annotationTypes = host.annotationTypes as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    annotationTypes.register?.("rect", {
      summarize: () => "",
      validate: () => [],
      note: 1,
    });
    expect(request).toHaveBeenCalledWith("annotationTypes.register", {
      localId: "rect",
      members: ["summarize", "validate"],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(report).toHaveBeenCalledWith(
      "log",
      expect.objectContaining({ level: "error" }),
    );
  });
});

describe("そのほかの呼び出しは、位置引数の配列のまま req になる", () => {
  it("annotations.create / groups.setMembers / assets.setMetadata", async () => {
    const t = setup();
    await t.host.annotations?.create?.({ a: 1 });
    await t.host.groups?.setMembers?.("g", ["n"]);
    await t.host.assets?.setMetadata?.("a1", { w: 1 }, "page:3");
    expect(t.request.mock.calls).toEqual([
      ["annotations.create", [{ a: 1 }]],
      ["groups.setMembers", ["g", ["n"]]],
      ["assets.setMetadata", ["a1", { w: 1 }, "page:3"]],
    ]);
  });
});
