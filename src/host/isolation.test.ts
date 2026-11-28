import { describe, expect, it, vi } from "vitest";
import { ChannelError } from "./channel";
import { createIsolation, type IsolationDeps } from "./isolation";

function setup(over: Partial<IsolationDeps> = {}) {
  let now = 0;
  const disable = vi.fn(async (_id: string) => {});
  const notify = vi.fn();
  const record = vi.fn();
  const removeFrames = vi.fn();
  const isolation = createIsolation({
    now: () => now,
    disable,
    notify,
    record,
    removeFrames,
    threshold: 3,
    windowMs: 1000,
    ...over,
  });
  return {
    isolation,
    disable,
    notify,
    record,
    removeFrames,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("失敗の帰属と自動停止", () => {
  it("枠の error 報告は、その拡張機能の失敗として記録される", () => {
    const { isolation, record } = setup();
    isolation.fail("a", "error", { message: "boom" });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ extId: "a", kind: "error", message: "boom" }),
    );
    expect(isolation.failureCount("a")).toBe(1);
    expect(isolation.failureCount("b")).toBe(0);
  });

  it("読み込み時・activate 中・Promise の拒否・setTimeout の例外（どれも枠の rep error）を数える", () => {
    const { isolation } = setup({ threshold: 10 });
    for (const phase of ["import", "activate", "unhandledrejection", "error"]) {
      isolation.fail("a", "error", { phase, message: phase });
    }
    expect(isolation.failureCount("a")).toBe(4);
  });

  it("期間内に閾値を超えたら無効にして通知する（1 回だけ）", async () => {
    const { isolation, disable, notify } = setup();
    for (let i = 0; i < 3; i++) isolation.fail("a", "error", { message: "x" });
    expect(disable).not.toHaveBeenCalled();
    isolation.fail("a", "error", { message: "x" });
    isolation.fail("a", "error", { message: "x" });
    expect(disable).toHaveBeenCalledTimes(1);
    expect(disable).toHaveBeenCalledWith("a");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("a", "disabled");
  });

  it("期間が過ぎた失敗は数えない", () => {
    const { isolation, disable, advance } = setup();
    for (let i = 0; i < 3; i++) {
      isolation.fail("a", "error", { message: "x" });
      advance(600);
    }
    expect(disable).not.toHaveBeenCalled();
  });

  it("他の拡張機能は止めない", () => {
    const { isolation, disable } = setup();
    for (let i = 0; i < 4; i++) isolation.fail("a", "error", { message: "x" });
    isolation.fail("b", "error", { message: "x" });
    expect(disable).toHaveBeenCalledTimes(1);
    expect(disable).not.toHaveBeenCalledWith("b");
  });

  it("log は失敗に数えない。拒否は数える", () => {
    const { isolation, record } = setup();
    isolation.fail("a", "log", { level: "info", args: ["hi"] });
    expect(isolation.failureCount("a")).toBe(0);
    isolation.fail("a", "rejected", { reason: "rateLimited" });
    expect(isolation.failureCount("a")).toBe(1);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("無効にしたあとの失敗は、重ねて無効にしない", () => {
    const { isolation, disable } = setup();
    for (let i = 0; i < 10; i++) isolation.fail("a", "error", { message: "x" });
    expect(disable).toHaveBeenCalledTimes(1);
  });

  it("reset で数え直せる（有効にし直したとき）", () => {
    const { isolation, disable } = setup();
    for (let i = 0; i < 4; i++) isolation.fail("a", "error", { message: "x" });
    isolation.reset("a");
    for (let i = 0; i < 3; i++) isolation.fail("a", "error", { message: "x" });
    expect(disable).toHaveBeenCalledTimes(1);
  });
});

describe("応答しない枠（ping）", () => {
  it("ping が時間切れの枠は、枠を取り除いて無効にし、通知する", async () => {
    const { isolation, disable, notify, removeFrames } = setup();
    const call = vi.fn(async () => {
      throw new ChannelError("Timeout", "no response to ping");
    });
    await isolation.probe("a", { call });
    expect(call).toHaveBeenCalledWith("ping", null);
    expect(removeFrames).toHaveBeenCalledWith("a");
    expect(disable).toHaveBeenCalledWith("a");
    expect(notify).toHaveBeenCalledWith("a", "unresponsive");
  });

  it("応答する枠には何もしない", async () => {
    const { isolation, disable, removeFrames } = setup();
    await isolation.probe("a", { call: async () => null });
    expect(removeFrames).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
  });

  it("枠が閉じられていた（Closed）ときは、応答しないとは見なさない", async () => {
    const { isolation, disable } = setup();
    await isolation.probe("a", {
      call: async () => {
        throw new ChannelError("Closed", "closed");
      },
    });
    expect(disable).not.toHaveBeenCalled();
  });
});
