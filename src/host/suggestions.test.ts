import { describe, expect, it, vi } from "vitest";
import { createManifestIndex } from "./host-api/manifests";
import { HostApiError } from "./host-api/permissions";
import { gateAllowing, setup } from "./host-api/test-support";
import { createSuggestionStore, type SuggestionDraft } from "./suggestions";

const EXT = "com.example.a";

function draft(
  id: string,
  assetId = "a1",
  itemKey: string | null = null,
): SuggestionDraft {
  return {
    id,
    assetId,
    itemKey,
    type: `${EXT}/rect`,
    summary: `rect ${id}`,
    selector: { x: 1 },
    labelId: null,
    command: { kind: "create_annotation", id } as never,
  };
}

function make() {
  const apply = vi.fn(async (_ext: string, _cmd: unknown) => {});
  const store = createSuggestionStore({ apply });
  return { store, apply };
}

describe("候補の仮の状態（FR-025）", () => {
  it("追加しても、DB（apply）には何も送らない。呼び出しは、利用者が決めるまで待つ", async () => {
    const { store, apply } = make();
    let settled = false;
    void store
      .add({ source: EXT, title: null, items: [draft("s1"), draft("s2")] })
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(store.count()).toBe(2);
    expect(store.list("a1", null).map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("対象（アセット・アイテム）ごとに持ち、別のアセットを見て戻っても再び出る（FR-027）", () => {
    const { store } = make();
    void store.add({ source: EXT, title: null, items: [draft("s1", "a1")] });
    void store.add({
      source: EXT,
      title: null,
      items: [draft("s2", "a2"), draft("s3", "a1", "page:2")],
    });
    expect(store.list("a2", null).map((s) => s.id)).toEqual(["s2"]);
    expect(store.list("a1", "page:2").map((s) => s.id)).toEqual(["s3"]);
    // a2 を見ている間も、a1 の候補は失われない。
    expect(store.list("a1", null).map((s) => s.id)).toEqual(["s1"]);
    expect(store.count()).toBe(3);
  });

  it("対象に候補が無ければ、同じ空の配列を返す。変化のない対象の配列は、そのまま", () => {
    const { store } = make();
    void store.add({ source: EXT, title: null, items: [draft("s1", "a1")] });
    const before = store.list("a1", null);
    void store.add({ source: EXT, title: null, items: [draft("s2", "a2")] });
    expect(store.list("a1", null)).toBe(before);
    expect(store.list("zzz", null)).toBe(store.list("yyy", null));
  });

  it("変化を購読者に知らせる", async () => {
    const { store } = make();
    const listener = vi.fn();
    store.subscribe(listener);
    void store.add({ source: EXT, title: null, items: [draft("s1")] });
    expect(listener).toHaveBeenCalledTimes(1);
    store.reject(["s1"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("採用（FR-026）", () => {
  it("1 件の採用は、そのまま 1 つのコマンドで送る。送り主は提案した拡張機能", async () => {
    const { store, apply } = make();
    const done = store.add({ source: EXT, title: null, items: [draft("s1")] });
    const accepted = await store.accept(["s1"]);
    expect(accepted).toEqual(["s1"]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(EXT, {
      kind: "create_annotation",
      id: "s1",
    });
    expect(store.count()).toBe(0);
    await expect(done).resolves.toEqual({ accepted: ["s1"], rejectedCount: 0 });
  });

  it("複数の採用は、1 つの Transaction（1 回の Undo）で送る", async () => {
    const { store, apply } = make();
    void store.add({
      source: EXT,
      title: null,
      items: [draft("s1"), draft("s2"), draft("s3")],
    });
    await store.accept(["s1", "s3"]);
    expect(apply).toHaveBeenCalledTimes(1);
    const [, command] = apply.mock.calls[0] ?? [];
    expect(command).toMatchObject({
      kind: "transaction",
      commands: [{ id: "s1" }, { id: "s3" }],
    });
    expect(store.list("a1", null).map((s) => s.id)).toEqual(["s2"]);
  });

  it("一括の採用（対象の全部）も 1 回の Transaction", async () => {
    const { store, apply } = make();
    void store.add({
      source: EXT,
      title: null,
      items: [draft("s1"), draft("s2"), draft("o1", "a2")],
    });
    const accepted = await store.acceptAll("a1", null);
    expect(accepted).toEqual(["s1", "s2"]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(store.list("a2", null).map((s) => s.id)).toEqual(["o1"]);
  });

  it("提案した拡張機能が違うものは、拡張機能ごとに送る（送り主を取り違えない）", async () => {
    const { store, apply } = make();
    void store.add({ source: "ext.a", title: null, items: [draft("s1")] });
    void store.add({ source: "ext.b", title: null, items: [draft("s2")] });
    await store.acceptAll("a1", null);
    expect(apply.mock.calls.map((c) => c[0]).sort()).toEqual([
      "ext.a",
      "ext.b",
    ]);
  });

  it("採用が失敗したら、候補は残り、エラーを返す。呼び出しも待ち続ける", async () => {
    const apply = vi.fn(async () => {
      throw new HostApiError("PermissionDenied", "revoked");
    });
    const store = createSuggestionStore({ apply });
    let settled = false;
    void store
      .add({ source: EXT, title: null, items: [draft("s1")] })
      .then(() => {
        settled = true;
      });
    await expect(store.accept(["s1"])).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    expect(store.count()).toBe(1);
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("二重に押されても、同じ候補は 1 度しか送らない", async () => {
    let release: () => void = () => {};
    const apply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const store = createSuggestionStore({ apply });
    void store.add({ source: EXT, title: null, items: [draft("s1")] });
    const first = store.accept(["s1"]);
    const second = await store.accept(["s1"]);
    expect(second).toEqual([]);
    release();
    await first;
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("知らない ID は無視する", async () => {
    const { store, apply } = make();
    expect(await store.accept(["nope"])).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("却下（FR-026）", () => {
  it("却下は何も送らず、残らない。呼び出しは、すべて決まったら件数つきで終わる", async () => {
    const { store, apply } = make();
    const done = store.add({
      source: EXT,
      title: null,
      items: [draft("s1"), draft("s2"), draft("s3")],
    });
    store.reject(["s1"]);
    await store.accept(["s2"]);
    store.rejectAll("a1", null);
    expect(apply).toHaveBeenCalledTimes(1); // 採用の 1 回だけ（却下では送らない）
    expect(store.count()).toBe(0);
    await expect(done).resolves.toEqual({ accepted: ["s2"], rejectedCount: 2 });
  });
});

describe("プロジェクトを閉じるとき（FR-027）", () => {
  it("残りの件数を知らせ、閉じるときに捨てる。待っている呼び出しは、却下として終わる", async () => {
    const { store, apply } = make();
    const done = store.add({
      source: EXT,
      title: null,
      items: [draft("s1"), draft("s2")],
    });
    expect(store.count()).toBe(2);
    expect(store.clearAll()).toBe(2);
    expect(store.count()).toBe(0);
    expect(apply).not.toHaveBeenCalled();
    await expect(done).resolves.toEqual({ accepted: [], rejectedCount: 2 });
  });
});

describe("5,000 件（SC-007）", () => {
  it("追加・一覧・一括の採用が、候補の数に比べて遅くならない。DB は触らない", async () => {
    const { store, apply } = make();
    const items = Array.from({ length: 5000 }, (_, i) => draft(`s${i}`));
    const t0 = performance.now();
    void store.add({ source: EXT, title: "bulk", items });
    expect(store.list("a1", null)).toHaveLength(5000);
    expect(apply).not.toHaveBeenCalled();
    const addMs = performance.now() - t0;
    const t1 = performance.now();
    await store.acceptAll("a1", null);
    const acceptMs = performance.now() - t1;
    expect(apply).toHaveBeenCalledTimes(1);
    expect(addMs).toBeLessThan(50);
    expect(acceptMs).toBeLessThan(100);
  });
});

describe("annotations.suggest（Host API）", () => {
  const manifest = JSON.stringify({
    id: EXT,
    contributes: { annotationTypes: [{ id: "rect", version: 3 }] },
  });
  const manifests = createManifestIndex(() => [{ id: EXT, manifest }]);
  const changeSet = { seq: 1, origin: "apply", changes: [], asset_ids: [] };

  interface Options {
    check?: (input: unknown) => Promise<{ summary: string }>;
    allowed?: string[];
  }

  function withStore(options: Options = {}) {
    const applyCommand = vi.fn(
      async (_extId: string, _command: unknown) => changeSet,
    );
    const check = vi.fn(options.check ?? (async () => ({ summary: "S" })));
    const store = createSuggestionStore({
      apply: async (extId, command) => {
        await applyCommand(extId, command);
      },
    });
    const t = setup({
      manifests,
      ...(options.allowed === undefined
        ? {}
        : { gate: gateAllowing(...options.allowed) }),
      typeChecks: { check },
      ipc: { applyCommand },
      suggestions: store,
    });
    return { ...t, applyCommand, check, store };
  }

  const rect = (assetId = "a1", extra: object = {}) => ({
    target: { assetId },
    type: `${EXT}/rect`,
    selector: { x: 1 },
    ...extra,
  });

  it("検査（種別・validate・summarize）を通したものを、仮の状態で持つ。書き込まない", async () => {
    const { call, check, store, applyCommand } = withStore();
    const pending = call("annotations.suggest", [
      [rect("a1"), rect("a2")],
      { title: "AI" },
    ]);
    await vi.waitFor(() => expect(store.count()).toBe(2));
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledWith({
      type: `${EXT}/rect`,
      selector: { x: 1 },
      assetId: "a1",
    });
    expect(applyCommand).not.toHaveBeenCalled();
    const [first] = store.list("a1", null);
    expect(first).toMatchObject({
      type: `${EXT}/rect`,
      summary: "S",
      source: EXT,
      title: "AI",
    });
    await store.acceptAll("a1", null);
    await store.acceptAll("a2", null);
    const result = (await pending) as { accepted: string[] };
    expect(result.accepted).toHaveLength(2);
  });

  it("採用のコマンドは create_annotation。source は拡張機能 ID、ID は採用後のアノテーションの ID", async () => {
    const { call, store, applyCommand } = withStore();
    const pending = call("annotations.suggest", [
      [rect("a1", { labelId: "l1", attributes: { k: "v" }, source: "evil" })],
    ]);
    await vi.waitFor(() => expect(store.count()).toBe(1));
    const [s] = store.list("a1", null);
    await store.accept([s?.id ?? ""]);
    expect(applyCommand).toHaveBeenCalledTimes(1);
    const [ext, command] = applyCommand.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(ext).toBe(EXT);
    expect(command).toMatchObject({
      kind: "create_annotation",
      id: s?.id,
      type: `${EXT}/rect`,
      type_version: 3,
      label_id: "l1",
      summary: "S",
      source: EXT,
    });
    await expect(pending).resolves.toEqual({
      accepted: [s?.id],
      rejectedCount: 0,
    });
  });

  it("1 件でも検査に通らなければ、ValidationFailed で何も持たない（どの項目かを示す）", async () => {
    let n = 0;
    const { call, store } = withStore({
      check: async () => {
        n += 1;
        if (n === 2) throw new HostApiError("ValidationFailed", "bad");
        return { summary: "" };
      },
    });
    await expect(
      call("annotations.suggest", [[rect(), rect(), rect()]]),
    ).rejects.toMatchObject({
      code: "ValidationFailed",
      message: expect.stringContaining("[1]"),
    });
    expect(store.count()).toBe(0);
  });

  it("annotations.write が無ければ PermissionDenied。何も持たない", async () => {
    const { call, store, check } = withStore({ allowed: ["annotations.read"] });
    await expect(call("annotations.suggest", [[rect()]])).rejects.toMatchObject(
      { code: "PermissionDenied" },
    );
    expect(check).not.toHaveBeenCalled();
    expect(store.count()).toBe(0);
  });

  it("形が違う引数・多すぎる候補は ValidationFailed", async () => {
    const { call, store } = withStore();
    await expect(call("annotations.suggest", ["x"])).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    await expect(
      call("annotations.suggest", [[{ type: 1 }]]),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(
      call("annotations.suggest", [[rect()], { title: 5 }]),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    const many = Array.from({ length: 20_001 }, () => rect());
    await expect(call("annotations.suggest", [many])).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    expect(store.count()).toBe(0);
  });

  it("空の一覧は、待たずに終わる", async () => {
    const { call } = withStore();
    await expect(call("annotations.suggest", [[]])).resolves.toEqual({
      accepted: [],
      rejectedCount: 0,
    });
  });

  it("5,000 件の検査も、並行して進む（直列より速い）", async () => {
    let active = 0;
    let peak = 0;
    const { call, store } = withStore({
      check: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return { summary: "" };
      },
    });
    const list = Array.from({ length: 5000 }, () => rect());
    void call("annotations.suggest", [list]);
    await vi.waitFor(() => expect(store.count()).toBe(5000), {
      timeout: 5000,
    });
    expect(peak).toBeGreaterThan(1);
  });

  it("suggestions を持たない本体では、使えない（Internal）", async () => {
    const t = setup({
      manifests,
      typeChecks: { check: async () => ({ summary: "" }) },
    });
    await expect(
      t.call("annotations.suggest", [[rect()]]),
    ).rejects.toMatchObject({ code: "Internal" });
  });
});
