import { describe, expect, it, vi } from "vitest";
import { type StartupDeps, startup } from "./startup";

function makeDeps(overrides: Partial<StartupDeps> = {}) {
  const order: string[] = [];
  let fire: () => void = () => {};
  const deps: StartupDeps = {
    setTitle: vi.fn(async (title: string) => {
      order.push(`setTitle:${title}`);
    }),
    appInfo: vi.fn(async () => {
      order.push("appInfo");
      return { name: "unnotator", version: "0.0.1" };
    }),
    reportReady: vi.fn(async () => {
      order.push("reportReady");
    }),
    t: vi.fn(() => "タイトル"),
    onFirstRender: (callback) => {
      fire = callback;
    },
    ...overrides,
  };
  return { deps, order, renderDone: () => fire() };
}

describe("startup", () => {
  it("t('app.title') でタイトルを設定し、appInfo を 1 回呼ぶ", async () => {
    const { deps, order } = makeDeps();
    await startup(deps);
    expect(deps.t).toHaveBeenCalledWith("app.title");
    expect(order).toContain("setTitle:タイトル");
    expect(deps.appInfo).toHaveBeenCalledTimes(1);
  });

  it("最初の描画が終わるまで reportReady を呼ばない", async () => {
    const { deps, order, renderDone } = makeDeps();
    await startup(deps);
    expect(deps.reportReady).not.toHaveBeenCalled();
    renderDone();
    await Promise.resolve();
    expect(deps.reportReady).toHaveBeenCalledTimes(1);
    expect(order.indexOf("reportReady")).toBeGreaterThan(
      order.indexOf("appInfo"),
    );
  });

  it("appInfo が失敗しても例外を外に出さない", async () => {
    const { deps } = makeDeps({
      appInfo: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(startup(deps)).resolves.toBeUndefined();
  });
});
