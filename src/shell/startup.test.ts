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

  it("設定の適用は、最初の描画を待たせない（描画の登録のあとに始める）", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const { deps } = makeDeps({
      onFirstRender: () => order.push("onFirstRender"),
      applySettings: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            order.push("applySettings");
            release = resolve;
          }),
      ),
    });
    await startup(deps);
    expect(order).toEqual(["onFirstRender", "applySettings"]);
    release();
  });

  it("設定の適用が失敗しても、例外を外に出さず、ready も妨げない", async () => {
    const { deps, renderDone } = makeDeps({
      applySettings: vi.fn(async () => {
        throw new Error("settings");
      }),
    });
    await expect(startup(deps)).resolves.toBeUndefined();
    renderDone();
    await Promise.resolve();
    expect(deps.reportReady).toHaveBeenCalledTimes(1);
  });
});
