// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type InitMessage, startFrame } from "../src/bootstrap";

interface Sent {
  t: string;
  [key: string]: unknown;
}

function setup(importModule: (url: string) => Promise<unknown>) {
  const channel = new MessageChannel();
  const received: Sent[] = [];
  channel.port1.onmessage = (event) => received.push(event.data as Sent);
  const stop = startFrame({ win: window, doc: document, importModule });
  const init: InitMessage = {
    t: "init",
    ext: { id: "com.example.a", version: "0.1.0", path: "" },
    role: "background",
    url: "unno://localhost/ext/com.example.a/dist/index.js",
    locale: "ja",
    messages: { hello: "こんにちは {name}" },
    theme: { "--color-bg": "#fff" },
    mirror: {
      selection: ["a"],
      "labels.active": null,
      settings: { "x.y": 1 },
      "assets.current": null,
      "tools.active": null,
    },
    base: "unno://localhost",
    ctx: {},
  };
  const deliver = (data: unknown, ports: MessagePort[] = [channel.port2]) => {
    window.dispatchEvent(
      Object.assign(new Event("message"), {
        data,
        ports,
        source: window.parent,
      }),
    );
  };
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const close = () => {
    stop();
    channel.port1.close();
    channel.port2.close();
  };
  return { channel, received, init, deliver, settle, close };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe("startFrame: init", () => {
  it("init を受けると拡張機能を import し、activate を host つきで呼び、ready を報告する", async () => {
    const activate = vi.fn(async (host: { extension: { id: string } }) => {
      expect(host.extension.id).toBe("com.example.a");
    });
    const importModule = vi.fn(async () => ({ activate }));
    const s = setup(importModule);
    cleanups.push(s.close);
    s.deliver(s.init);
    await s.settle();
    expect(importModule).toHaveBeenCalledWith(s.init.url);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(s.received).toContainEqual({ t: "rep", kind: "ready", v: null });
  });

  it("init の前の message や、port の無い init は無視する", async () => {
    const importModule = vi.fn(async () => ({ activate: vi.fn() }));
    const s = setup(importModule);
    cleanups.push(s.close);
    s.deliver({ t: "other" });
    s.deliver(s.init, []);
    s.deliver("text");
    await s.settle();
    expect(importModule).not.toHaveBeenCalled();
  });

  it("2 回目の init は無視する", async () => {
    const importModule = vi.fn(async () => ({ activate: vi.fn() }));
    const s = setup(importModule);
    cleanups.push(s.close);
    s.deliver(s.init);
    s.deliver(s.init);
    await s.settle();
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it("テーマの色の変数を文書に適用する", async () => {
    const s = setup(async () => ({ activate: vi.fn() }));
    cleanups.push(s.close);
    s.deliver(s.init);
    await s.settle();
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe(
      "#fff",
    );
  });
});

describe("startFrame: 写し", () => {
  it("host の同期の API は写しから返り、ev で更新される", async () => {
    let host: {
      selection: {
        get(): string[];
        onDidChange(cb: (v: string[]) => void): { dispose(): void };
      };
      i18n: {
        t(k: string, v?: Record<string, string>): string;
        locale: string;
      };
      assets: { url(id: string): string };
    } | null = null;
    const s = setup(async () => ({
      activate: (h: unknown) => {
        host = h as typeof host;
      },
    }));
    cleanups.push(s.close);
    s.deliver(s.init);
    await s.settle();
    expect(host?.selection.get()).toEqual(["a"]);
    expect(host?.i18n.t("hello", { name: "A" })).toBe("こんにちは A");
    expect(host?.i18n.locale).toBe("ja");
    expect(host?.assets.url("id1")).toBe("unno://localhost/asset/id1");
    const seen: string[][] = [];
    host?.selection.onDidChange((v) => seen.push(v));
    s.channel.port1.postMessage({ t: "ev", k: "selection", v: ["b", "c"] });
    await s.settle();
    expect(host?.selection.get()).toEqual(["b", "c"]);
    expect(seen).toEqual([["b", "c"]]);
  });
});

describe("startFrame: 呼び出し", () => {
  it("非同期の API は req になり、res で解決する", async () => {
    let host: { assets: { get(id: string): Promise<unknown> } } | null = null;
    const s = setup(async () => ({
      activate: (h: unknown) => {
        host = h as typeof host;
      },
    }));
    cleanups.push(s.close);
    s.deliver(s.init);
    await s.settle();
    const p = host?.assets.get("id1");
    await s.settle();
    const req = s.received.find((m) => m.t === "req");
    expect(req).toMatchObject({ m: "assets.get", a: ["id1"] });
    s.channel.port1.postMessage({
      t: "res",
      id: req?.id,
      ok: true,
      v: { id: "id1" },
    });
    await expect(p).resolves.toEqual({ id: "id1" });
  });

  it("失敗の res は code つきの例外になる", async () => {
    let host: { assets: { get(id: string): Promise<unknown> } } | null = null;
    const s = setup(async () => ({
      activate: (h: unknown) => {
        host = h as typeof host;
      },
    }));
    cleanups.push(s.close);
    s.deliver(s.init);
    await s.settle();
    const p = host?.assets.get("id1");
    const assertion = expect(p).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    await s.settle();
    const req = s.received.find((m) => m.t === "req");
    s.channel.port1.postMessage({
      t: "res",
      id: req?.id,
      ok: false,
      code: "PermissionDenied",
      msg: "no",
    });
    await assertion;
  });

  it("登録したコマンドを、本体からの call で呼べる", async () => {
    const handler = vi.fn(() => 42);
    const s = setup(async () => ({
      activate: (h: {
        commands: { register(id: string, f: () => number): void };
      }) => {
        h.commands.register("run", handler);
      },
    }));
    cleanups.push(s.close);
    s.deliver(s.init);
    await s.settle();
    s.channel.port1.postMessage({
      t: "call",
      id: 5,
      m: "invoke",
      a: { kind: "commands", localId: "run", args: [1] },
    });
    await s.settle();
    expect(handler).toHaveBeenCalledWith(1);
    expect(s.received).toContainEqual({ t: "res", id: 5, ok: true, v: 42 });
  });
});

describe("startFrame: 失敗の報告", () => {
  it("import() の失敗を本体へ報告する", async () => {
    const s = setup(async () => {
      throw new Error("load failed");
    });
    cleanups.push(s.close);
    s.deliver(s.init);
    await s.settle();
    const report = s.received.find((m) => m.t === "rep" && m.kind === "error");
    expect(report).toMatchObject({
      v: { phase: "import", message: "load failed" },
    });
    expect(s.received.some((m) => m.t === "rep" && m.kind === "ready")).toBe(
      false,
    );
  });

  it("activate の例外を報告する", async () => {
    const s = setup(async () => ({
      activate: () => {
        throw new Error("bad activate");
      },
    }));
    cleanups.push(s.close);
    s.deliver(s.init);
    await s.settle();
    expect(
      s.received.find((m) => m.t === "rep" && m.kind === "error"),
    ).toMatchObject({ v: { phase: "activate", message: "bad activate" } });
  });

  it("window の error を報告する", async () => {
    const s = setup(async () => ({ activate: vi.fn() }));
    cleanups.push(s.close);
    s.deliver(s.init);
    await s.settle();
    window.dispatchEvent(
      new ErrorEvent("error", { message: "boom", error: new Error("boom") }),
    );
    await s.settle();
    expect(
      s.received.find(
        (m) =>
          m.t === "rep" &&
          m.kind === "error" &&
          (m.v as { phase: string }).phase === "error",
      ),
    ).toMatchObject({ v: { message: "boom" } });
  });

  it("unhandledrejection を報告する", async () => {
    const s = setup(async () => ({ activate: vi.fn() }));
    cleanups.push(s.close);
    s.deliver(s.init);
    await s.settle();
    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), {
        reason: new Error("nope"),
      }),
    );
    await s.settle();
    expect(
      s.received.find(
        (m) =>
          m.t === "rep" &&
          (m.v as { phase?: string })?.phase === "unhandledrejection",
      ),
    ).toMatchObject({ v: { message: "nope" } });
  });
});

describe("startFrame: 画面の枠（エディター・ビュー・プレビュー）", () => {
  it("openEditor に、container・asset・signal・setTitle つきの ctx を渡し、ready を報告する", async () => {
    const openEditor = vi.fn(async () => ({
      dispose: vi.fn(),
      reveal: vi.fn(),
    }));
    const s = setup(async () => ({ openEditor }));
    cleanups.push(s.close);
    s.deliver({
      ...s.init,
      role: "editor",
      ctx: { asset: { id: "a1" }, itemKey: "page:1" },
    });
    await s.settle();
    const ctx = openEditor.mock.calls[0]?.[0] as unknown as {
      container: HTMLElement;
      asset: { id: string };
      itemKey: string;
      signal: AbortSignal;
      setTitle(title: string): void;
    };
    expect(ctx.asset).toEqual({ id: "a1" });
    expect(ctx.itemKey).toBe("page:1");
    expect(ctx.container).toBeInstanceOf(HTMLElement);
    expect(ctx.signal.aborted).toBe(false);
    ctx.setTitle("Doc");
    expect(document.title).toBe("Doc");
    expect(s.received).toContainEqual({ t: "rep", kind: "ready", v: null });
  });

  it("本体からの dispose で、signal を中断し、インスタンスの dispose を呼ぶ", async () => {
    const dispose = vi.fn();
    let signal: AbortSignal | undefined;
    const s = setup(async () => ({
      openEditor: async (ctx: { signal: AbortSignal }) => {
        signal = ctx.signal;
        return { dispose, reveal: vi.fn() };
      },
    }));
    cleanups.push(s.close);
    s.deliver({ ...s.init, role: "editor" });
    await s.settle();
    s.channel.port1.postMessage({ t: "call", id: 9, m: "dispose", a: null });
    await s.settle();
    expect(signal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(s.received).toContainEqual({ t: "res", id: 9, ok: true, v: null });
  });

  it("resolveView の ctx で、表示状態の変化を ev で受けられる", async () => {
    const seen: boolean[] = [];
    const s = setup(async () => ({
      resolveView: async (ctx: {
        onDidChangeVisibility(cb: (v: boolean) => void): unknown;
      }) => {
        ctx.onDidChangeVisibility((v) => seen.push(v));
        return { dispose: vi.fn() };
      },
    }));
    cleanups.push(s.close);
    s.deliver({ ...s.init, role: "view" });
    await s.settle();
    s.channel.port1.postMessage({ t: "ev", k: "visibility", v: false });
    await s.settle();
    expect(seen).toEqual([false]);
  });

  it("テーマの更新（ev theme）を、枠の中の色の変数に反映する", async () => {
    const s = setup(async () => ({
      renderPreview: async () => ({ dispose() {} }),
    }));
    cleanups.push(s.close);
    s.deliver({ ...s.init, role: "preview" });
    await s.settle();
    s.channel.port1.postMessage({
      t: "ev",
      k: "theme",
      v: { "--color-bg": "#222" },
    });
    await s.settle();
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe(
      "#222",
    );
  });

  it("invoke に withSignal があれば、最後の引数に signal を足し、abort の call で中断する", async () => {
    let seen: AbortSignal | undefined;
    const s = setup(async () => ({
      activate: (h: {
        items: { register(id: string, impl: object): void };
      }) => {
        h.items.register("pages", {
          list: (_a: unknown, _r: unknown, signal: AbortSignal) => {
            seen = signal;
            return new Promise(() => {});
          },
        });
      },
    }));
    cleanups.push(s.close);
    s.deliver(s.init);
    await s.settle();
    s.channel.port1.postMessage({
      t: "call",
      id: 3,
      m: "invoke",
      a: {
        kind: "items",
        localId: "pages",
        member: "list",
        args: [{ id: "a" }, { offset: 0, limit: 1 }],
        withSignal: "tok",
      },
    });
    await s.settle();
    expect(seen?.aborted).toBe(false);
    s.channel.port1.postMessage({
      t: "call",
      id: 4,
      m: "abort",
      a: { token: "tok" },
    });
    await s.settle();
    expect(seen?.aborted).toBe(true);
  });
});

describe("startFrame: ping", () => {
  it("本体の ping に、拡張機能の処理を待たずに答える", async () => {
    const s = setup(async () => ({ activate: vi.fn() }));
    cleanups.push(s.close);
    s.deliver(s.init);
    await s.settle();
    s.channel.port1.postMessage({ t: "call", id: 77, m: "ping", a: null });
    await s.settle();
    expect(s.received).toContainEqual({ t: "res", id: 77, ok: true, v: null });
  });
});
