// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createPlacementRuntime } from "./placement-instance";
import type { ExtensionHost, ExtensionInfo } from "./service";

function fakeHost() {
  let infos: ExtensionInfo[] = [];
  const listeners = new Set<(i: readonly ExtensionInfo[]) => void>();
  const host = {
    infos: () => infos,
    onDidRefresh: (l: (i: readonly ExtensionInfo[]) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    frames: {},
    manager: { versionOf: () => "0.0.1" },
  } as unknown as ExtensionHost;
  return {
    host,
    set(next: ExtensionInfo[]) {
      infos = next;
      for (const l of [...listeners]) l(infos);
    },
  };
}

const withEditor = (id: string, extra = {}): ExtensionInfo => ({
  id,
  version: "0.0.1",
  status: "enabled",
  manifest: JSON.stringify({
    id,
    name: `Name ${id}`,
    contributes: {
      editors: [
        {
          id: "e",
          title: "E",
          mediaTypes: ["img/png"],
          entry: "e.js",
          ...extra,
        },
      ],
    },
  }),
});

describe("createPlacementRuntime", () => {
  it("一覧が変わると宣言を集め直し、変わったときだけ知らせる", () => {
    const f = fakeHost();
    const runtime = createPlacementRuntime(f.host);
    const changed = vi.fn();
    runtime.onDidChangeSurfaces(changed);
    f.set([withEditor("x.a")]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(runtime.placement.resolve("img/png").kind).toBe("editor");
    // 同じ宣言のままの読み直しでは、知らせない（開いている画面を作り直さない）
    f.set([withEditor("x.a")]);
    expect(changed).toHaveBeenCalledTimes(1);
    // 無効になったら、知らせる
    f.set([]);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(runtime.placement.resolve("img/png").kind).toBe("generic");
  });

  it("宣言が変わった拡張機能の失敗の記録を消す", () => {
    const f = fakeHost();
    const runtime = createPlacementRuntime(f.host);
    f.set([withEditor("x.a")]);
    runtime.placement.reportFailure("x.a/e");
    expect(runtime.placement.resolve("img/png").kind).toBe("generic");
    f.set([withEditor("x.a", { title: "E2" })]);
    expect(runtime.placement.resolve("img/png").kind).toBe("editor");
  });

  it("表示名はマニフェストの name、無ければ ID", () => {
    const f = fakeHost();
    const runtime = createPlacementRuntime(f.host);
    f.set([withEditor("x.a")]);
    expect(runtime.nameOf("x.a")).toBe("Name x.a");
    expect(runtime.nameOf("x.none")).toBe("x.none");
  });
});
