import { describe, expect, it, vi } from "vitest";
import { apiPaths } from "../src/api-members";
import { createHost } from "../src/host-proxy";
import { createMirror } from "../src/mirror";

describe("apiPaths: activate の戻り値から、関数のメンバーの名前を集める", () => {
  it("関数と入れ子の関数を、ドット区切りで返す", () => {
    expect(
      apiPaths({
        answer: () => 1,
        nested: { name: () => "x", deep: { f() {} } },
        n: 3,
      }).sort(),
    ).toEqual(["answer", "nested.deep.f", "nested.name"]);
  });
  it("オブジェクトでなければ空", () => {
    expect(apiPaths(undefined)).toEqual([]);
    expect(apiPaths(5)).toEqual([]);
  });
  it("循環・深すぎる入れ子・多すぎる数を打ち切る", () => {
    const loop: Record<string, unknown> = { f: () => 1 };
    loop.self = loop;
    expect(apiPaths(loop)).toEqual(["f"]);
    expect(
      apiPaths(
        Object.fromEntries(
          Array.from({ length: 2000 }, (_, i) => [`f${i}`, () => 1]),
        ),
      ).length,
    ).toBeLessThanOrEqual(1000);
  });
});

function setup(reply: unknown) {
  const request = vi.fn(async (_m: string, _a: unknown) => reply);
  const { host, registry } = createHost({
    ext: { id: "a.rect", version: "0.0.1", path: "" },
    mirror: createMirror({}),
    locale: "en",
    messages: {},
    base: "unno://localhost",
    request,
    report: () => {},
  });
  return { host, registry, request };
}

describe("getApi（枠の中）", () => {
  it("名前の表から、入れ子のプロキシを作り、呼び出しは req になる", async () => {
    const { host, request } = setup(["answer", "nested.name"]);
    const extensions = host.extensions as {
      getApi(id: string): Promise<{
        answer(a: string): Promise<number>;
        nested: { name(): Promise<string> };
      }>;
    };
    request.mockResolvedValueOnce(["answer", "nested.name"]);
    const api = await extensions.getApi("a.base");
    request.mockResolvedValueOnce(7);
    await expect(api.answer("a")).resolves.toBe(7);
    expect(request).toHaveBeenLastCalledWith("extensions.getApi", {
      id: "a.base",
      call: "answer",
      args: ["a"],
    });
    request.mockResolvedValueOnce("n");
    await expect(api.nested.name()).resolves.toBe("n");
    expect(request).toHaveBeenLastCalledWith("extensions.getApi", {
      id: "a.base",
      call: "nested.name",
      args: [],
    });
  });
});

describe("公開した API を、本体からの invoke で呼ぶ", () => {
  it("setApi した関数を、member の名前で呼べる", async () => {
    const { registry } = setup([]);
    registry.setApi({
      answer: (a: number) => a * 2,
      nested: { name: () => "n" },
    });
    await expect(registry.invoke("api", "", "answer", [4])).resolves.toBe(8);
    await expect(registry.invoke("api", "", "nested.name", [])).resolves.toBe(
      "n",
    );
    await expect(registry.invoke("api", "", "missing", [])).rejects.toThrow();
  });
});
