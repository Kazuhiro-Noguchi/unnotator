import { describe, expect, it, vi } from "vitest";
import {
  type ActivationDeps,
  ActivationManager,
  type ExtensionDescriptor,
  Registrations,
} from "./activation";

function ext(
  id: string,
  options: Partial<ExtensionDescriptor> = {},
): ExtensionDescriptor {
  return {
    id,
    version: "1.0.0",
    activationEvents: [],
    dependencies: {},
    enabled: true,
    ...options,
  };
}

function setup(
  list: ExtensionDescriptor[],
  deps: Partial<ActivationDeps> = {},
) {
  const started: string[] = [];
  const stopped: string[] = [];
  const full: ActivationDeps = {
    start: vi.fn(async (id: string) => {
      started.push(id);
    }),
    stop: vi.fn(async (id: string) => {
      stopped.push(id);
    }),
    satisfies: (range, version) => range === "*" || range === `^${version}`,
    ...deps,
  };
  const manager = new ActivationManager(full);
  manager.setExtensions(list);
  return { manager, started, stopped, deps: full };
}

describe("起動時は何も読まない", () => {
  it("setExtensions だけでは start を呼ばない", () => {
    const { started } = setup([
      ext("a.b", { activationEvents: ["onStartup"] }),
    ]);
    expect(started).toEqual([]);
  });
});

describe("活性化イベント", () => {
  it.each([
    ["onStartup"],
    ["onMediaType:image"],
    ["onEditor:a.b/rect"],
    ["onCommand:a.b.run"],
    ["onExport"],
  ])("%s は、一致する拡張機能だけを有効にする", async (event) => {
    const { manager, started } = setup([
      ext("a.hit", { activationEvents: [event] }),
      ext("a.miss", { activationEvents: ["onCommand:other"] }),
      ext("a.none"),
    ]);
    await manager.trigger(event);
    expect(started).toEqual(["a.hit"]);
    expect(manager.state("a.hit").status).toBe("active");
    expect(manager.state("a.miss").status).toBe("inactive");
  });

  it("無効な拡張機能は、イベントが来ても有効にならない", async () => {
    const { manager, started } = setup([
      ext("a.off", { activationEvents: ["onStartup"], enabled: false }),
    ]);
    await manager.trigger("onStartup");
    expect(started).toEqual([]);
    expect(manager.state("a.off").status).toBe("disabled");
  });
});

describe("1 回だけ", () => {
  it("同時に何度要求しても start は 1 回", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { manager, deps } = setup([ext("a.b")], {
      start: vi.fn(async () => {
        await gate;
      }),
    });
    const p = [
      manager.activate("a.b"),
      manager.activate("a.b"),
      manager.activate("a.b"),
    ];
    expect(manager.state("a.b").status).toBe("activating");
    release();
    await Promise.all(p);
    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(manager.state("a.b").status).toBe("active");
  });

  it("有効になったあとの要求では、もう start しない", async () => {
    const { manager, deps } = setup([ext("a.b")]);
    await manager.activate("a.b");
    await manager.activate("a.b");
    expect(deps.start).toHaveBeenCalledTimes(1);
  });
});

describe("依存順", () => {
  it("依存先が先に有効になる", async () => {
    const { manager, started } = setup([
      ext("a.rect", { dependencies: { "a.base": "*" } }),
      ext("a.base"),
    ]);
    await manager.activate("a.rect");
    expect(started).toEqual(["a.base", "a.rect"]);
  });

  it("依存先が既に有効なら、もう一度は start しない", async () => {
    const { manager, started } = setup([
      ext("a.rect", { dependencies: { "a.base": "*" } }),
      ext("a.base"),
    ]);
    await manager.activate("a.base");
    await manager.activate("a.rect");
    expect(started).toEqual(["a.base", "a.rect"]);
  });

  it("依存先が無いと、有効にせず理由を保持する", async () => {
    const { manager, started } = setup([
      ext("a.rect", { dependencies: { "a.missing": "*" } }),
    ]);
    await manager.activate("a.rect");
    expect(started).toEqual([]);
    expect(manager.state("a.rect")).toMatchObject({
      status: "failed",
      failure: { code: "MissingDependency", extensionId: "a.missing" },
    });
  });

  it("版が範囲外だと、有効にしない", async () => {
    const { manager, started } = setup([
      ext("a.rect", { dependencies: { "a.base": "^9.0.0" } }),
      ext("a.base"),
    ]);
    await manager.activate("a.rect");
    expect(started).toEqual([]);
    expect(manager.state("a.rect").failure?.code).toBe("VersionMismatch");
  });

  it("循環は、どれも有効にしない", async () => {
    const { manager, started } = setup([
      ext("a.x", { dependencies: { "a.y": "*" } }),
      ext("a.y", { dependencies: { "a.x": "*" } }),
    ]);
    await manager.activate("a.x");
    expect(started).toEqual([]);
    expect(manager.state("a.x").failure?.code).toBe("Cycle");
  });

  it("依存先が無効なら、依存元は有効にしない", async () => {
    const { manager, started } = setup([
      ext("a.rect", { dependencies: { "a.base": "*" } }),
      ext("a.base", { enabled: false }),
    ]);
    await manager.activate("a.rect");
    expect(started).toEqual([]);
    expect(manager.state("a.rect").failure?.code).toBe("DependencyFailed");
  });

  it("依存先の start が失敗したら、依存元は DependencyFailed", async () => {
    const { manager, started } = setup(
      [ext("a.rect", { dependencies: { "a.base": "*" } }), ext("a.base")],
      {
        start: vi.fn(async (id: string) => {
          if (id === "a.base") throw new Error("boom");
        }),
      },
    );
    await manager.activate("a.rect");
    expect(started).toEqual([]);
    expect(manager.state("a.base").failure?.code).toBe("StartFailed");
    expect(manager.state("a.rect").failure?.code).toBe("DependencyFailed");
  });
});

describe("失敗", () => {
  it("start の失敗は failed と理由になり、他の拡張機能に影響しない", async () => {
    const { manager } = setup([ext("a.bad"), ext("a.good")], {
      start: vi.fn(async (id: string) => {
        if (id === "a.bad") throw new Error("boom");
      }),
    });
    await manager.activate("a.bad");
    await manager.activate("a.good");
    expect(manager.state("a.bad")).toMatchObject({
      status: "failed",
      failure: { code: "StartFailed", message: "boom" },
    });
    expect(manager.state("a.good").status).toBe("active");
  });

  it("failed のあと、明示の再試行で有効にできる", async () => {
    let fail = true;
    const { manager } = setup([ext("a.b")], {
      start: vi.fn(async () => {
        if (fail) throw new Error("boom");
      }),
    });
    await manager.activate("a.b");
    expect(manager.state("a.b").status).toBe("failed");
    fail = false;
    await manager.activate("a.b", { retry: true });
    expect(manager.state("a.b").status).toBe("active");
  });

  it("状態の変化を購読できる", async () => {
    const { manager } = setup([ext("a.b")]);
    const seen: string[] = [];
    manager.onDidChange((id, state) => seen.push(`${id}:${state.status}`));
    await manager.activate("a.b");
    expect(seen).toEqual(["a.b:activating", "a.b:active"]);
  });
});

describe("終了処理（T025）", () => {
  it("deactivate は stop を呼び、登録をすべて取り消す", async () => {
    const { manager, stopped } = setup([ext("a.b")]);
    const dispose = vi.fn();
    await manager.activate("a.b");
    manager.registrations.add("a.b", "commands", "run", { dispose });
    await manager.deactivate("a.b");
    expect(stopped).toEqual(["a.b"]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.state("a.b").status).toBe("inactive");
    expect(manager.registrations.keys("a.b")).toEqual([]);
  });

  it("stop が応答しなくても、時間切れのあと枠は取り除かれ登録は消える", async () => {
    vi.useFakeTimers();
    try {
      const dispose = vi.fn();
      const { manager } = setup([ext("a.b")], {
        stop: vi.fn(() => new Promise<void>(() => {})),
      });
      await manager.activate("a.b");
      manager.registrations.add("a.b", "commands", "run", { dispose });
      const done = manager.deactivate("a.b", { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1001);
      await done;
      expect(dispose).toHaveBeenCalled();
      expect(manager.state("a.b").status).toBe("inactive");
    } finally {
      vi.useRealTimers();
    }
  });

  it("有効でない拡張機能の deactivate は何もしない", async () => {
    const { manager, stopped } = setup([ext("a.b")]);
    await manager.deactivate("a.b");
    expect(stopped).toEqual([]);
  });

  it("無効にすると deactivate し、状態は disabled になる", async () => {
    const { manager, stopped } = setup([ext("a.b")]);
    await manager.activate("a.b");
    await manager.disable("a.b");
    expect(stopped).toEqual(["a.b"]);
    expect(manager.state("a.b").status).toBe("disabled");
    await manager.activate("a.b");
    expect(manager.state("a.b").status).toBe("disabled");
  });

  it("deactivateAll（プロジェクトを閉じる・アプリ終了）は有効なものすべて", async () => {
    const { manager, stopped } = setup([ext("a.x"), ext("a.y")]);
    await manager.activate("a.x");
    await manager.activate("a.y");
    await manager.deactivateAll();
    expect(stopped.sort()).toEqual(["a.x", "a.y"]);
  });
});

describe("Registrations", () => {
  it("dispose は 2 回呼んでも安全で、取り消し後の dispose は何もしない", () => {
    const regs = new Registrations();
    const dispose = vi.fn();
    const handle = regs.add("a.b", "commands", "run", { dispose });
    handle.dispose();
    handle.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(regs.keys("a.b")).toEqual([]);
  });

  it("ID が衝突したら、あとから入れた方を拒み、既存を壊さない", () => {
    const regs = new Registrations();
    const first = vi.fn();
    const second = vi.fn();
    regs.add("a.b", "commands", "run", { dispose: first });
    expect(() =>
      regs.add("a.c", "commands", "run", { dispose: second }),
    ).toThrow(/already registered/);
    expect(regs.owner("commands", "run")).toBe("a.b");
    regs.disposeAll("a.c");
    expect(first).not.toHaveBeenCalled();
  });

  it("disposeAll の途中で 1 つが例外を投げても、残りを取り消す", () => {
    const regs = new Registrations();
    const ok = vi.fn();
    regs.add("a.b", "commands", "x", {
      dispose: () => {
        throw new Error("bad");
      },
    });
    regs.add("a.b", "items", "y", { dispose: ok });
    regs.disposeAll("a.b");
    expect(ok).toHaveBeenCalled();
    expect(regs.keys("a.b")).toEqual([]);
  });
});
