import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_LIMITS,
  createRateLimiter,
  HostChannel,
  inspectEnvelope,
  type PortLike,
} from "./channel";

const methods = new Set(["annotations.create", "selection.get"]);
const inspect = (data: unknown) => inspectEnvelope(data, { methods });

describe("inspectEnvelope: 形", () => {
  it("正しい req を通す", () => {
    const r = inspect({
      t: "req",
      id: 1,
      m: "annotations.create",
      a: { x: 1 },
    });
    expect(r.ok).toBe(true);
  });
  it("res・rep を通す", () => {
    expect(inspect({ t: "res", id: 1, ok: true, v: 1 }).ok).toBe(true);
    expect(
      inspect({ t: "res", id: 1, ok: false, code: "Denied", msg: "x" }).ok,
    ).toBe(true);
    expect(inspect({ t: "rep", kind: "ready", v: null }).ok).toBe(true);
  });
  it.each([
    null,
    "text",
    42,
    [],
    {},
    { t: "zzz" },
    { t: "req", id: "1", m: "selection.get", a: null },
    { t: "req", id: 1.5, m: "selection.get", a: null },
    { t: "req", id: 1, m: 5, a: null },
    { t: "res", id: 1 },
    { t: "rep", kind: "other", v: 1 },
  ])("形が違うものを拒む: %j", (data) => {
    const r = inspect(data);
    expect(r.ok).toBe(false);
  });
});

describe("inspectEnvelope: 未知の m", () => {
  it("表に無い m は拒否する", () => {
    const r = inspect({ t: "req", id: 1, m: "__tauri.invoke", a: {} });
    expect(r).toMatchObject({ ok: false, reason: "unknownMethod" });
  });
  it("プロトタイプのキーも拒否する", () => {
    expect(inspect({ t: "req", id: 1, m: "constructor", a: {} }).ok).toBe(
      false,
    );
    expect(inspect({ t: "req", id: 1, m: "__proto__", a: {} }).ok).toBe(false);
  });
});

describe("inspectEnvelope: 大きさ・深さ・長さ", () => {
  it("1 MiB を超える文字列を拒む", () => {
    const big = "a".repeat(CHANNEL_LIMITS.maxBytes + 1);
    expect(
      inspect({ t: "req", id: 1, m: "selection.get", a: big }),
    ).toMatchObject({
      ok: false,
      reason: "tooLarge",
    });
  });
  it("多数の小さな値の合計でも拒む", () => {
    const a = Array.from({ length: 9000 }, () => "x".repeat(200));
    expect(inspect({ t: "req", id: 1, m: "selection.get", a }).ok).toBe(false);
  });
  it("深さ 32 を超える入れ子を拒む", () => {
    let v: unknown = 1;
    for (let i = 0; i < CHANNEL_LIMITS.maxDepth + 2; i++) v = { v };
    expect(
      inspect({ t: "req", id: 1, m: "selection.get", a: v }),
    ).toMatchObject({
      ok: false,
      reason: "tooDeep",
    });
  });
  it("深さ 32 ちょうどまでは通す", () => {
    let v: unknown = 1;
    for (let i = 0; i < CHANNEL_LIMITS.maxDepth - 2; i++) v = { v };
    expect(inspect({ t: "req", id: 1, m: "selection.get", a: v }).ok).toBe(
      true,
    );
  });
  it("配列の長さ 10,000 を超えるものを拒む", () => {
    const a = new Array(CHANNEL_LIMITS.maxArrayLength + 1).fill(0);
    expect(inspect({ t: "req", id: 1, m: "selection.get", a })).toMatchObject({
      ok: false,
      reason: "tooLong",
    });
  });
});

describe("inspectEnvelope: 危険な値", () => {
  it("循環を拒む", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(inspect({ t: "req", id: 1, m: "selection.get", a })).toMatchObject({
      ok: false,
    });
  });
  it("関数を含む値を拒む", () => {
    expect(
      inspect({ t: "req", id: 1, m: "selection.get", a: { f: () => 1 } }),
    ).toMatchObject({
      ok: false,
      reason: "badValue",
    });
  });
  it("symbol・bigint を拒む", () => {
    expect(
      inspect({ t: "req", id: 1, m: "selection.get", a: Symbol("x") }).ok,
    ).toBe(false);
    expect(inspect({ t: "req", id: 1, m: "selection.get", a: 1n }).ok).toBe(
      false,
    );
  });
  it("DOM の要素のような非プレーンなオブジェクトを拒む", () => {
    class FakeElement {
      nodeType = 1;
    }
    expect(
      inspect({ t: "req", id: 1, m: "selection.get", a: new FakeElement() }).ok,
    ).toBe(false);
  });
  it("ArrayBuffer は通し、大きさに数えない", () => {
    const buf = new ArrayBuffer(CHANNEL_LIMITS.maxBytes * 2);
    expect(
      inspect({ t: "req", id: 1, m: "selection.get", a: { buf } }).ok,
    ).toBe(true);
  });
  it("NaN・Infinity は拒む", () => {
    expect(
      inspect({ t: "req", id: 1, m: "selection.get", a: Number.NaN }).ok,
    ).toBe(false);
  });
});

describe("inspectEnvelope: 自己申告の ID", () => {
  it("封筒の ext・source・from などは取り除く", () => {
    const r = inspect({
      t: "req",
      id: 1,
      m: "selection.get",
      a: null,
      ext: "other.ext",
      source: "manual",
      from: "x",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.envelope).sort()).toEqual(["a", "id", "m", "t"]);
    }
  });
});

describe("createRateLimiter", () => {
  it("毎秒 500 件を超えると拒む", () => {
    let now = 0;
    const limit = createRateLimiter(() => now);
    for (let i = 0; i < CHANNEL_LIMITS.maxPerSecond; i++)
      expect(limit()).toBe(true);
    expect(limit()).toBe(false);
    now = 1001;
    expect(limit()).toBe(true);
  });
});

function fakePort() {
  const sent: unknown[] = [];
  const port: PortLike & { emit(data: unknown): void } = {
    onmessage: null,
    postMessage: (m: unknown) => {
      sent.push(m);
    },
    close: vi.fn(),
    emit(data: unknown) {
      this.onmessage?.({ data } as MessageEvent);
    },
  };
  return { port, sent };
}

describe("HostChannel", () => {
  it("req を、port で決まる送り主つきでハンドラに渡し、res を返す", async () => {
    const { port, sent } = fakePort();
    const handle = vi.fn(async () => "done");
    new HostChannel(port, { extId: "a.b", methods, handle });
    port.emit({ t: "req", id: 7, m: "selection.get", a: 1, ext: "evil" });
    await Promise.resolve();
    await Promise.resolve();
    expect(handle).toHaveBeenCalledWith({
      extId: "a.b",
      m: "selection.get",
      a: 1,
    });
    expect(sent).toContainEqual({ t: "res", id: 7, ok: true, v: "done" });
  });
  it("ハンドラの失敗を res の失敗にする", async () => {
    const { port, sent } = fakePort();
    const handle = vi.fn(async () => {
      throw Object.assign(new Error("no"), { code: "PermissionDenied" });
    });
    new HostChannel(port, { extId: "a.b", methods, handle });
    port.emit({ t: "req", id: 1, m: "selection.get", a: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toContainEqual({
      t: "res",
      id: 1,
      ok: false,
      code: "PermissionDenied",
      msg: "no",
    });
  });
  it("検査に落ちたものは失敗に数え、ハンドラを呼ばない", () => {
    const { port } = fakePort();
    const handle = vi.fn();
    const onReject = vi.fn();
    const ch = new HostChannel(port, {
      extId: "a.b",
      methods,
      handle,
      onReject,
    });
    port.emit({ t: "req", id: 1, m: "nope", a: null });
    expect(handle).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith("unknownMethod");
    expect(ch.rejectedCount).toBe(1);
  });
  it("call の応答が 30 秒で Timeout になる", async () => {
    vi.useFakeTimers();
    try {
      const { port, sent } = fakePort();
      const ch = new HostChannel(port, {
        extId: "a.b",
        methods,
        handle: vi.fn(),
      });
      const p = ch.call("provider.run", { x: 1 });
      const assertion = expect(p).rejects.toMatchObject({ code: "Timeout" });
      expect(sent[0]).toMatchObject({ t: "call", m: "provider.run" });
      await vi.advanceTimersByTimeAsync(CHANNEL_LIMITS.timeoutMs + 1);
      await assertion;
      expect(ch.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("call に res が来ると解決する", async () => {
    const { port, sent } = fakePort();
    const ch = new HostChannel(port, {
      extId: "a.b",
      methods,
      handle: vi.fn(),
    });
    const p = ch.call("provider.run", null);
    const id = (sent[0] as { id: number }).id;
    port.emit({ t: "res", id, ok: true, v: 5 });
    await expect(p).resolves.toBe(5);
  });
  it("知らない id の res は無視する", () => {
    const { port } = fakePort();
    const onReject = vi.fn();
    new HostChannel(port, { extId: "a.b", methods, handle: vi.fn(), onReject });
    port.emit({ t: "res", id: 999, ok: true, v: 1 });
    expect(onReject).toHaveBeenCalledWith("unknownResponse");
  });
  it("close すると保留中の呼び出しが失敗し、port が閉じる", async () => {
    const { port } = fakePort();
    const ch = new HostChannel(port, {
      extId: "a.b",
      methods,
      handle: vi.fn(),
    });
    const p = ch.call("provider.run", null);
    const assertion = expect(p).rejects.toMatchObject({ code: "Closed" });
    ch.close();
    await assertion;
    expect(port.close).toHaveBeenCalled();
    expect(ch.pendingCount).toBe(0);
  });
  it("頻度の上限を超えると拒む", () => {
    const { port } = fakePort();
    const handle = vi.fn(async () => null);
    const onReject = vi.fn();
    new HostChannel(port, {
      extId: "a.b",
      methods,
      handle,
      onReject,
      now: () => 0,
    });
    for (let i = 0; i < CHANNEL_LIMITS.maxPerSecond + 5; i++) {
      port.emit({ t: "req", id: i, m: "selection.get", a: null });
    }
    expect(handle).toHaveBeenCalledTimes(CHANNEL_LIMITS.maxPerSecond);
    expect(onReject).toHaveBeenCalledWith("rateLimited");
  });
});
