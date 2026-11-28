import { describe, expect, it, vi } from "vitest";
import { createMetrics, SLOW_CALL_MS } from "./metrics";

describe("createMetrics（FR-023）", () => {
  it("読み込み・有効化の時間を拡張機能ごとに記録する", () => {
    const m = createMetrics();
    m.recordActivation("a.b", 12);
    m.recordActivation("a.c", 30);
    expect(m.snapshot()["a.b"]?.activationMs).toBe(12);
    expect(m.snapshot()["a.c"]?.activationMs).toBe(30);
  });

  it("呼び出し回数・合計・最大・失敗回数を数える", () => {
    const m = createMetrics();
    m.recordCall("a.b", "assets.get", 10, true);
    m.recordCall("a.b", "assets.get", 30, true);
    m.recordCall("a.b", "annotations.create", 5, false);
    expect(m.snapshot()["a.b"]).toMatchObject({
      calls: 3,
      totalCallMs: 45,
      maxCallMs: 30,
      failures: 1,
      slowCalls: 0,
    });
  });

  it("50 ms を超える呼び出しは、遅い呼び出しとして数え、警告として通知する", () => {
    const onSlow = vi.fn();
    const m = createMetrics({ onSlow });
    m.recordCall("a.b", "assets.read", SLOW_CALL_MS, true);
    expect(onSlow).not.toHaveBeenCalled();
    m.recordCall("a.b", "assets.read", SLOW_CALL_MS + 1, true);
    expect(onSlow).toHaveBeenCalledWith("a.b", "assets.read", SLOW_CALL_MS + 1);
    expect(m.snapshot()["a.b"]?.slowCalls).toBe(1);
  });

  it("警告は、同じ拡張機能・同じ名前につき 1 秒に 1 回だけ（洪水にしない）", () => {
    let now = 0;
    const onSlow = vi.fn();
    const m = createMetrics({ onSlow, now: () => now });
    m.recordCall("a.b", "x", 100, true);
    m.recordCall("a.b", "x", 100, true);
    expect(onSlow).toHaveBeenCalledTimes(1);
    now = 1500;
    m.recordCall("a.b", "x", 100, true);
    expect(onSlow).toHaveBeenCalledTimes(2);
    expect(m.snapshot()["a.b"]?.slowCalls).toBe(3);
  });

  it("reset でその拡張機能の記録が消える", () => {
    const m = createMetrics();
    m.recordCall("a.b", "x", 1, true);
    m.reset("a.b");
    expect(m.snapshot()["a.b"]).toBeUndefined();
  });

  it("購読者に、変化を知らせる", () => {
    const m = createMetrics();
    const seen = vi.fn();
    const sub = m.subscribe(seen);
    m.recordCall("a.b", "x", 1, true);
    expect(seen).toHaveBeenCalledTimes(1);
    sub.dispose();
    m.recordCall("a.b", "x", 1, true);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
