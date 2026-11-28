// `assets.readText` は枠の中で処理する: ホストへは `assets.read`（バイト列）だけを送り、
// 文字への変換は枠の側で行う。ホスト（コア）は文字コードを知らない。
import { describe, expect, it, vi } from "vitest";
import { createHost } from "../src/host-proxy";
import { createMirror } from "../src/mirror";

function setup(reply: ArrayBuffer | Error) {
  const request = vi.fn(async (_m: string, _a: unknown) => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const { host } = createHost({
    ext: { id: "a.b", version: "0.0.1", path: "" },
    mirror: createMirror({}),
    locale: "en",
    messages: {},
    base: "unno://localhost",
    request,
    report: () => {},
  });
  const assets = host.assets as {
    readText(id: string, encoding?: string): Promise<string>;
  };
  return { assets, request };
}

describe("assets.readText（枠の中）", () => {
  it("assets.read だけを呼び、既定は UTF-8 で文字にする", async () => {
    const bytes = new TextEncoder().encode("こんにちは");
    const { assets, request } = setup(bytes.buffer as ArrayBuffer);
    await expect(assets.readText("a1")).resolves.toBe("こんにちは");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("assets.read", ["a1"]);
  });

  it("encoding を指定できる", async () => {
    const bytes = Uint8Array.from([0xe9]); // latin1 の é
    const { assets } = setup(bytes.buffer as ArrayBuffer);
    await expect(assets.readText("a1", "latin1")).resolves.toBe("é");
  });

  it("未知の encoding は ValidationFailed", async () => {
    const { assets, request } = setup(new ArrayBuffer(0));
    await expect(
      assets.readText("a1", "no-such-encoding"),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(request).not.toHaveBeenCalled();
  });

  it("読み取りの失敗は、そのまま返す", async () => {
    const err = Object.assign(new Error("denied"), {
      code: "PermissionDenied",
    });
    const { assets } = setup(err);
    await expect(assets.readText("a1")).rejects.toMatchObject({
      code: "PermissionDenied",
    });
  });
});
