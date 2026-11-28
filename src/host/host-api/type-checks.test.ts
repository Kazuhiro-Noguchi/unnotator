import { describe, expect, it, vi } from "vitest";
import type { HostIpc } from "./ipc";
import { createManifestIndex } from "./manifests";
import { setup } from "./test-support";
import { createTypeChecks, type TypeChecksDeps } from "./type-checks";

const DEFINER = "com.example.shape";
const manifest = JSON.stringify({
  id: DEFINER,
  contributes: { annotationTypes: [{ id: "rect", version: 2 }] },
});

const asset = {
  id: "a1",
  root_key: "",
  rel_path: "a.png",
  media_type: "com.example.image/png",
  file_size: 1,
  mtime_ms: 2,
  status: "todo" as const,
  missing: false,
  metadata_json: "{}",
  attributes_json: "{}",
};

type Call = (m: string, a: unknown) => Promise<unknown>;

function checks(
  call: Call,
  overrides: Partial<TypeChecksDeps> = {},
  frame = true,
) {
  return createTypeChecks({
    manifests: createManifestIndex(() => [{ id: DEFINER, manifest }]),
    background: async () => (frame ? { call } : undefined),
    members: () => ["summarize", "validate"],
    asset: async () => asset,
    locale: () => "ja",
    timeoutMs: 30,
    ...overrides,
  });
}

const input = {
  type: `${DEFINER}/rect`,
  selector: { x: 1 },
  assetId: "a1",
};

describe("validate / summarize の問い合わせ（FR-017・research R3）", () => {
  it("定義側の裏の枠へ、validate → summarize の順に invoke で問い合わせ、summary を返す", async () => {
    const call = vi.fn<Call>(async (_m, a) =>
      (a as { member: string }).member === "validate" ? [] : "矩形 1x2",
    );
    await expect(checks(call).check(input)).resolves.toEqual({
      summary: "矩形 1x2",
    });
    expect(
      call.mock.calls.map((c) => (c[1] as { member: string }).member),
    ).toEqual(["validate", "summarize"]);
    expect(call.mock.calls[0]?.[0]).toBe("invoke");
    expect(call.mock.calls[0]?.[1]).toMatchObject({
      kind: "annotationTypes",
      localId: "rect",
      args: [{ x: 1 }, expect.objectContaining({ id: "a1", relPath: "a.png" })],
    });
    // summarize の文脈は { asset, locale }
    expect(call.mock.calls[1]?.[1]).toMatchObject({
      args: [
        { x: 1 },
        { asset: expect.objectContaining({ id: "a1" }), locale: "ja" },
      ],
    });
  });

  it("validate が理由を返したら ValidationFailed（理由を含む）。summarize は呼ばない", async () => {
    const call = vi.fn<Call>(async () => ["幅が負です", "高さが負です"]);
    await expect(checks(call).check(input)).rejects.toMatchObject({
      code: "ValidationFailed",
      message: expect.stringContaining("幅が負です"),
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("枠の中で例外が出たら ValidationFailed", async () => {
    const call = vi.fn<Call>(async () => {
      throw Object.assign(new Error("boom"), { code: "Internal" });
    });
    await expect(checks(call).check(input)).rejects.toMatchObject({
      code: "ValidationFailed",
    });
  });

  it("応答が無ければ Timeout", async () => {
    const call = vi.fn<Call>(() => new Promise(() => {}));
    await expect(checks(call).check(input)).rejects.toMatchObject({
      code: "Timeout",
    });
  });

  it("枠の通信が Timeout を返しても Timeout", async () => {
    const call = vi.fn<Call>(async () => {
      throw Object.assign(new Error("no response"), { code: "Timeout" });
    });
    await expect(checks(call).check(input)).rejects.toMatchObject({
      code: "Timeout",
    });
  });

  it("validate が登録されていなければ、呼ばない。summarize が無ければ summary は空", async () => {
    const call = vi.fn<Call>(async () => "x");
    const only = checks(call, { members: () => ["summarize"] });
    await only.check(input);
    expect(
      call.mock.calls.map((c) => (c[1] as { member: string }).member),
    ).toEqual(["summarize"]);
    const none = checks(call, { members: () => [] });
    await expect(none.check(input)).resolves.toEqual({ summary: "" });
  });

  it("summarize の戻り値が文字列でなければ ValidationFailed。長すぎる summary は切り詰める", async () => {
    await expect(
      checks(async (_m, a) =>
        (a as { member: string }).member === "validate" ? [] : 42,
      ).check(input),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    const long = await checks(async (_m, a) =>
      (a as { member: string }).member === "validate" ? [] : "あ".repeat(2000),
    ).check(input);
    expect(long.summary.length).toBeLessThanOrEqual(500);
  });

  it("validate の戻り値が配列でなければ ValidationFailed", async () => {
    await expect(checks(async () => "ok").check(input)).rejects.toMatchObject({
      code: "ValidationFailed",
    });
  });

  it("コアの種別（core/…）は、問い合わせない", async () => {
    const call = vi.fn<Call>();
    await expect(
      checks(call).check({ ...input, type: "core/classification" }),
    ).resolves.toEqual({ summary: "" });
    expect(call).not.toHaveBeenCalled();
  });

  it("定義側のマニフェストに宣言がない種別・定義側の枠が得られない・アセットが無いときは ValidationFailed", async () => {
    const call = vi.fn<Call>(async () => []);
    await expect(
      checks(call).check({ ...input, type: `${DEFINER}/circle` }),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(
      checks(call).check({ ...input, type: "com.unknown/rect" }),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(checks(call, {}, false).check(input)).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    await expect(
      checks(call, { asset: async () => null }).check(input),
    ).rejects.toMatchObject({ code: "NotFound" });
    expect(call).not.toHaveBeenCalled();
  });
});

describe("書き込みへの結び", () => {
  const manifests = createManifestIndex(() => [
    { id: DEFINER, manifest },
    { id: "com.example.b", manifest: "{}" },
  ]);
  const changeSet = { seq: 1, origin: "apply", changes: [], asset_ids: [] };

  function wired(call: Call, ipc: Partial<HostIpc> = {}) {
    const applyCommand = vi.fn(async () => changeSet);
    const t = setup({
      manifests,
      typeChecks: checks(call, { manifests }),
      ipc: { applyCommand, ...ipc },
    });
    return { ...t, applyCommand };
  }
  const create = (extra: object = {}) => [
    {
      target: { assetId: "a1" },
      type: `${DEFINER}/rect`,
      selector: { x: 1 },
      ...extra,
    },
  ];

  it("他の拡張機能の種別を作るときも、定義側の枠に問い合わせて、summary を command に載せる", async () => {
    const { call, applyCommand } = wired(async (_m, a) =>
      (a as { member: string }).member === "validate" ? [] : "矩形",
    );
    const created = (await call(
      "annotations.create",
      create(),
      "com.example.b",
    )) as {
      summary: string;
    };
    expect(created.summary).toBe("矩形");
    expect((applyCommand.mock.calls[0] as unknown[])[1]).toMatchObject({
      kind: "create_annotation",
      summary: "矩形",
    });
  });

  it("validate に落ちたら、書かずに ValidationFailed（transaction の途中でも、その呼び出しで失敗する）", async () => {
    const { call, applyCommand } = wired(async () => ["だめ"]);
    await expect(call("annotations.create", create())).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    await call("annotations.transaction", { op: "begin", label: "x" });
    await expect(call("annotations.create", create())).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    await call("annotations.transaction", { op: "commit" });
    expect(applyCommand).not.toHaveBeenCalled();
  });

  it("応答が無ければ Timeout で、書かない", async () => {
    const { call, applyCommand } = wired(() => new Promise(() => {}));
    await expect(call("annotations.create", create())).rejects.toMatchObject({
      code: "Timeout",
    });
    expect(applyCommand).not.toHaveBeenCalled();
  });

  it("update: selector を変えるときは、既存の種別で検査して summary も更新する。種別は読み取りで知る", async () => {
    const row = {
      id: "n1",
      asset_id: "a1",
      item_key: null,
      type: `${DEFINER}/rect`,
      type_version: 2,
      selector_json: "{}",
      label_id: null,
      attributes_json: "{}",
      summary: "",
      z_order: 0,
      source: "manual",
      created_at: 1,
      updated_at: 1,
    };
    const { call, applyCommand } = wired(
      async (_m, a) =>
        (a as { member: string }).member === "validate" ? [] : "新しい矩形",
      { annotationsQuery: vi.fn(async () => [row]) },
    );
    await call("annotations.update", ["n1", { selector: { x: 9 } }]);
    expect((applyCommand.mock.calls[0] as unknown[])[1]).toMatchObject({
      kind: "update_annotation",
      patch: {
        selector_json: { kind: "set", value: '{"x":9}' },
        summary: { kind: "set", value: "新しい矩形" },
      },
    });
  });
});
