import { describe, expect, it, vi } from "vitest";
import { Registrations } from "../activation";
import { createManifestIndex } from "./manifests";
import { fakeShell, setup } from "./test-support";

const EXT = "com.example.a";
const manifest = JSON.stringify({
  id: EXT,
  contributes: {
    commands: [{ id: "run", title: "x" }],
    annotationTypes: [{ id: "rect", version: 1 }],
    itemProviders: [{ id: "pages" }],
    exporters: [{ id: "csv" }],
    importers: [{ id: "csv" }],
    statusBarItems: [
      {
        id: "zoom",
        alignment: "right",
        priority: 5,
        command: "com.example.a/run",
      },
    ],
    views: [{ id: "list" }],
    tools: [{ id: "pen" }],
  },
});
const other = JSON.stringify({
  id: "com.example.b",
  contributes: { views: [{ id: "panel" }], tools: [{ id: "brush" }] },
});
const manifests = createManifestIndex(() => [
  { id: EXT, manifest },
  { id: "com.example.b", manifest: other },
]);

function miscSetup(overrides: Parameters<typeof setup>[0] = {}) {
  const shell = fakeShell();
  const registrations = new Registrations();
  const members = new Map<string, readonly string[]>();
  const callFrame = vi.fn(async () => "result");
  const t = setup({
    manifests,
    shell,
    members,
    callFrame,
    registrations: () => registrations,
    ...overrides,
  });
  return { ...t, shell, registrations, members, callFrame };
}

describe("register（宣言がないものは拒否。FR-031）", () => {
  it("宣言したコマンドは登録でき、シェルのコマンドの処理に結ばれる。実行は枠の invoke になる", async () => {
    const { call, shell, registrations, callFrame } = miscSetup();
    await call("commands.register", { localId: "run", members: [] });
    expect(registrations.keys(EXT)).toEqual([`commands:${EXT}/run`]);
    const provide = shell.provideCommand as ReturnType<typeof vi.fn>;
    expect(provide).toHaveBeenCalledWith(`${EXT}/run`, expect.any(Function));
    const run = provide.mock.calls[0]?.[1] as (a: unknown) => Promise<unknown>;
    await expect(run({ x: 1 })).resolves.toBe("result");
    expect(callFrame).toHaveBeenCalledWith(EXT, "invoke", {
      kind: "commands",
      localId: "run",
      args: [{ x: 1 }],
    });
  });

  it("宣言のない名前は ValidationFailed で、何も登録しない", async () => {
    const { call, shell, registrations } = miscSetup();
    for (const [m, id] of [
      ["commands.register", "nope"],
      ["annotationTypes.register", "circle"],
      ["items.register", "other"],
      ["exporters.register", "xml"],
      ["importers.register", "xml"],
    ] as const) {
      await expect(call(m, { localId: id, members: [] })).rejects.toMatchObject(
        { code: "ValidationFailed" },
      );
    }
    expect(registrations.keys(EXT)).toEqual([]);
    expect(shell.provideCommand).not.toHaveBeenCalled();
  });

  it("種別・アイテム提供・書き出し・取り込みの登録は、メンバーの名前を覚える", async () => {
    const { call, members, registrations } = miscSetup();
    await call("annotationTypes.register", {
      localId: "rect",
      members: ["summarize", "validate"],
    });
    await call("items.register", { localId: "pages", members: ["list"] });
    await call("exporters.register", { localId: "csv", members: ["export"] });
    await call("importers.register", { localId: "csv", members: ["import"] });
    expect(members.get(`${EXT}\u0000rect`)).toEqual(["summarize", "validate"]);
    expect(registrations.keys(EXT)).toHaveLength(4);
  });

  it("同じものの二重登録は拒否。取り消し（disposeAll）で、シェルの処理も外れる", async () => {
    const dispose = vi.fn();
    const shell = fakeShell({ provideCommand: vi.fn(() => ({ dispose })) });
    const { call, registrations } = miscSetup({ shell });
    await call("commands.register", { localId: "run", members: [] });
    await expect(
      call("commands.register", { localId: "run", members: [] }),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    registrations.disposeAll(EXT);
    expect(dispose).toHaveBeenCalledTimes(1);
    // 取り消した後は、もう一度登録できる
    await call("commands.register", { localId: "run", members: [] });
  });

  it("editors / previewers / views の register は、マニフェストの entry で宣言するので拒否する", async () => {
    const { call } = miscSetup();
    for (const m of [
      "editors.register",
      "previewers.register",
      "views.register",
    ]) {
      await expect(
        call(m, { localId: "x", members: [] }),
      ).rejects.toMatchObject({ code: "ValidationFailed" });
    }
  });

  it("登録の引数が不正なら ValidationFailed（localId・members の型）", async () => {
    const { call } = miscSetup();
    await expect(
      call("commands.register", { localId: 1 }),
    ).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    await expect(
      call("commands.register", { localId: "run", members: "x" }),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(call("commands.register", null)).rejects.toMatchObject({
      code: "ValidationFailed",
    });
  });
});

describe("commands / tools", () => {
  it("commands.execute: シェルのコマンドを実行して値を返す。未登録は NotFound、失敗は Internal", async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: 7 })
      .mockResolvedValueOnce({ ok: false, reason: "unknown" })
      .mockResolvedValueOnce({ ok: false, reason: "failed" });
    const { call } = miscSetup({ shell: fakeShell({ executeCommand }) });
    await expect(call("commands.execute", ["a.b/c", { k: 1 }])).resolves.toBe(
      7,
    );
    expect(executeCommand).toHaveBeenCalledWith("a.b/c", { k: 1 });
    await expect(call("commands.execute", ["a.b/c"])).rejects.toMatchObject({
      code: "NotFound",
    });
    await expect(call("commands.execute", ["a.b/c"])).rejects.toMatchObject({
      code: "Internal",
    });
    await expect(call("commands.execute", [1])).rejects.toMatchObject({
      code: "ValidationFailed",
    });
  });

  it("tools.activate: 宣言されたツールか null だけ。写し（tools.active）を更新する", async () => {
    const { call, state } = miscSetup();
    await call("tools.activate", [`${EXT}/pen`]);
    expect(state.get("tools.active")).toBe(`${EXT}/pen`);
    await call("tools.activate", [`com.example.b/brush`]);
    expect(state.get("tools.active")).toBe("com.example.b/brush");
    await call("tools.activate", [null]);
    expect(state.get("tools.active")).toBeNull();
    await expect(call("tools.activate", ["x.y/zzz"])).rejects.toMatchObject({
      code: "NotFound",
    });
    expect(state.get("tools.active")).toBeNull();
  });
});

describe("ui / context（表示する文字は文字として扱い、長さを制限する。FR-031）", () => {
  it("ui.notify: レベルを検査し、長い文字列は切り詰めて、送り主の ID つきで出す", async () => {
    const notify = vi.fn();
    const { call } = miscSetup({ shell: fakeShell({ notify }) });
    await call("ui.notify", ["<b>こんにちは</b>"]);
    await call("ui.notify", ["x".repeat(5000), "error"]);
    expect(notify).toHaveBeenNthCalledWith(1, "info", "<b>こんにちは</b>", EXT);
    expect(notify.mock.calls[1]?.[1]).toHaveLength(500);
    expect(notify.mock.calls[1]?.[0]).toBe("error");
    await expect(call("ui.notify", ["x", "fatal"])).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    await expect(call("ui.notify", [{}])).rejects.toMatchObject({
      code: "ValidationFailed",
    });
  });

  it("ui.confirm: ホストが描く確認。結果は真偽値。文言は切り詰める", async () => {
    const confirm = vi.fn(async () => false);
    const { call } = miscSetup({ shell: fakeShell({ confirm }) });
    await expect(
      call("ui.confirm", ["消しますか？", { okLabel: "消す" }]),
    ).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith({
      extId: EXT,
      message: "消しますか？",
      okLabel: "消す",
      cancelLabel: undefined,
    });
    await call("ui.confirm", ["m".repeat(5000)]);
    expect(
      (confirm.mock.calls[1] as unknown as [{ message: string }])[0].message
        .length,
    ).toBeLessThanOrEqual(1000);
  });

  it("ui.setStatusBarItem: 宣言した項目だけ。位置・優先度・コマンドはマニフェストから。null で消す", async () => {
    const setStatusBarItem = vi.fn();
    const { call } = miscSetup({ shell: fakeShell({ setStatusBarItem }) });
    await call("ui.setStatusBarItem", [
      "zoom",
      { text: "100%", tooltip: "倍率" },
    ]);
    expect(setStatusBarItem).toHaveBeenCalledWith(
      {
        source: EXT,
        id: "zoom",
        alignment: "right",
        priority: 5,
        text: "100%",
        tooltip: "倍率",
        command: "com.example.a/run",
      },
      { source: EXT, id: "zoom" },
    );
    await call("ui.setStatusBarItem", ["zoom", null]);
    expect(setStatusBarItem).toHaveBeenLastCalledWith(null, {
      source: EXT,
      id: "zoom",
    });
    await expect(
      call("ui.setStatusBarItem", ["undeclared", { text: "x" }]),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(
      call("ui.setStatusBarItem", ["zoom", { text: 5 }]),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it("ui.showView: 宣言されたビューだけ（自分のものも、他の拡張機能のものも）", async () => {
    const showView = vi.fn();
    const { call } = miscSetup({ shell: fakeShell({ showView }) });
    await call("ui.showView", [`${EXT}/list`]);
    await call("ui.showView", ["com.example.b/panel"]);
    expect(showView).toHaveBeenCalledTimes(2);
    await expect(call("ui.showView", ["x.y/z"])).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  it("context.set: キーと値を検査し、拡張機能 ID の名前空間に入れる", async () => {
    const setContext = vi.fn();
    const { call } = miscSetup({ shell: fakeShell({ setContext }) });
    await call("context.set", ["hasSelection", true]);
    await call("context.set", ["mode", null]);
    expect(setContext).toHaveBeenCalledWith(EXT, "hasSelection", true);
    await expect(call("context.set", ["bad key!", 1])).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    await expect(call("context.set", ["k", { a: 1 }])).rejects.toMatchObject({
      code: "ValidationFailed",
    });
  });
});

describe("storage（plugin_data。Undo 対象外）", () => {
  it("set / get: JSON の値を、プロジェクト・アセット・アイテムの単位で出し入れする。ID は自分に固定", async () => {
    const storageSet = vi.fn(async () => {});
    const storageGet = vi.fn(async () => '{"a":[1,2]}');
    const { call } = miscSetup({ ipc: { storageSet, storageGet } });
    await call("storage.set", ["k", { a: [1, 2] }]);
    await call("storage.set", ["k", 1, { assetId: "a1" }]);
    await call("storage.set", ["k", 2, { assetId: "a1", itemKey: "page:3" }]);
    expect(storageSet.mock.calls).toEqual([
      [EXT, { kind: "project", id: "" }, "k", '{"a":[1,2]}'],
      [EXT, { kind: "asset", id: "a1" }, "k", "1"],
      [EXT, { kind: "item", id: "a1/page:3" }, "k", "2"],
    ]);
    await expect(call("storage.get", ["k"])).resolves.toEqual({ a: [1, 2] });
    expect(storageGet).toHaveBeenCalledWith(
      EXT,
      { kind: "project", id: "" },
      "k",
    );
  });

  it("get: 無ければ undefined。不正なスコープ・キー・大きすぎる値は ValidationFailed", async () => {
    const storageSet = vi.fn(async () => {});
    const { call } = miscSetup({
      ipc: { storageGet: vi.fn(async () => null), storageSet },
    });
    await expect(call("storage.get", ["k"])).resolves.toBeUndefined();
    await expect(call("storage.get", ["", undefined])).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    await expect(
      call("storage.get", ["k", { itemKey: "p" }]),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(
      call("storage.set", ["k", "x".repeat(2 * 1024 * 1024)]),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(call("storage.set", ["k", undefined])).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    expect(storageSet).not.toHaveBeenCalled();
  });
});

describe("projectFiles", () => {
  it("read: 無ければ null、あれば ArrayBuffer。write: 文字列も ArrayBuffer も書ける", async () => {
    const projectFileRead = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([104, 105]);
    const projectFileWrite = vi.fn(async () => {});
    const { call } = miscSetup({ ipc: { projectFileRead, projectFileWrite } });
    await expect(call("projectFiles.read", ["a.txt"])).resolves.toBeNull();
    const data = (await call("projectFiles.read", ["a.txt"])) as ArrayBuffer;
    expect(new Uint8Array(data)).toEqual(new Uint8Array([104, 105]));
    await call("projectFiles.write", ["a.txt", "hi"]);
    await call("projectFiles.write", ["b.bin", new Uint8Array([1, 2]).buffer]);
    expect(projectFileWrite.mock.calls).toEqual([
      [EXT, "a.txt", [104, 105]],
      [EXT, "b.bin", [1, 2]],
    ]);
    await expect(
      call("projectFiles.write", ["a.txt", 5]),
    ).rejects.toMatchObject({
      code: "ValidationFailed",
    });
  });
});

describe("python（ワーカーが無い間）", () => {
  it("python.request / readBlob は『利用できない』を返す（FR-019）", async () => {
    const { call } = miscSetup();
    await expect(call("python.request", ["m", {}])).rejects.toMatchObject({
      code: "PythonUnavailable",
    });
    await expect(call("python.readBlob", ["b1"])).rejects.toMatchObject({
      code: "PythonUnavailable",
    });
  });
});
