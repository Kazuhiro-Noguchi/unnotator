import { describe, expect, it, vi } from "vitest";
import { gateAllowing, setup } from "./test-support";

const asset = {
  id: "a1",
  root_key: "",
  rel_path: "img/cat.png",
  media_type: "com.example.image/png",
  file_size: 12,
  mtime_ms: 345,
  status: "in_progress" as const,
  missing: false,
  metadata_json: '{"com.example.a":{"width":10}}',
  attributes_json: '{"quality":"good"}',
};

const annotation = {
  id: "n1",
  asset_id: "a1",
  item_key: "page:3",
  type: "com.example.shape/rect",
  type_version: 2,
  selector_json: '{"x":1,"y":2}',
  label_id: "l1",
  attributes_json: '{"note":"x"}',
  summary: "矩形",
  z_order: 4,
  source: "com.example.a",
  created_at: 100,
  updated_at: 200,
};

describe("権限の門", () => {
  it("権限が無いと、IPC を呼ぶ前に PermissionDenied で止まる", async () => {
    const assetGet = vi.fn(async () => asset);
    const { call } = setup({
      gate: gateAllowing(),
      ipc: { assetGet },
    });
    await expect(call("assets.get", ["a1"])).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    expect(assetGet).not.toHaveBeenCalled();
  });

  it("表にないメソッドは、実装があっても通らない", async () => {
    const { call } = setup();
    await expect(call("evil.run", [])).rejects.toMatchObject({
      code: "PermissionDenied",
    });
  });

  it("Rust の IPC の拒否（needs_consent・permission_denied）は PermissionDenied、not_found は NotFound", async () => {
    const { call } = setup({
      ipc: {
        assetGet: vi.fn(async () => {
          throw { code: "needs_consent", message: "x" };
        }),
        itemGet: vi.fn(async () => {
          throw { code: "not_found", message: "x" };
        }),
        labelsList: vi.fn(async () => {
          throw { code: "weird", message: "x" };
        }),
      },
    });
    await expect(call("assets.get", ["a1"])).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    await expect(call("assets.getItem", ["a1", "k"])).rejects.toMatchObject({
      code: "NotFound",
    });
    await expect(call("labels.list", [])).rejects.toMatchObject({
      code: "Internal",
    });
  });
});

describe("assets", () => {
  it("get: Asset の形にして返す（メタ情報は拡張機能 ID ごと・属性は JSON から）", async () => {
    const assetGet = vi.fn(async () => asset);
    const { call } = setup({ ipc: { assetGet } });
    await expect(call("assets.get", ["a1"])).resolves.toEqual({
      id: "a1",
      rootKey: "",
      relPath: "img/cat.png",
      mediaType: "com.example.image/png",
      fileSize: 12,
      mtimeMs: 345,
      status: "in_progress",
      missing: false,
      metadata: { "com.example.a": { width: 10 } },
      attributes: { quality: "good" },
    });
    expect(assetGet).toHaveBeenCalledWith("com.example.a", "a1");
  });

  it("get: 存在しなければ NotFound。壊れた JSON は空として扱う", async () => {
    const rows = [
      null,
      { ...asset, metadata_json: "{oops", attributes_json: "[]" },
    ];
    const { call } = setup({
      ipc: { assetGet: vi.fn(async () => rows.shift() ?? null) },
    });
    await expect(call("assets.get", ["zz"])).rejects.toMatchObject({
      code: "NotFound",
    });
    await expect(call("assets.get", ["a1"])).resolves.toMatchObject({
      metadata: {},
      attributes: {},
    });
  });

  it("getItem: 無ければ null", async () => {
    const itemGet = vi.fn(async () => null);
    const { call } = setup({ ipc: { itemGet } });
    await expect(call("assets.getItem", ["a1", "page:9"])).resolves.toBeNull();
    expect(itemGet).toHaveBeenCalledWith("com.example.a", "a1", "page:9");
  });

  it("getItem: Item の形にして返す", async () => {
    const { call } = setup({
      ipc: {
        itemGet: vi.fn(async () => ({
          id: "i1",
          asset_id: "a1",
          item_key: "page:3",
          provider: "com.example.doc/pages",
          status: "done" as const,
          metadata_json: '{"k":1}',
          attributes_json: "{}",
        })),
      },
    });
    await expect(call("assets.getItem", ["a1", "page:3"])).resolves.toEqual({
      id: "i1",
      assetId: "a1",
      key: "page:3",
      provider: "com.example.doc/pages",
      status: "done",
      metadata: { k: 1 },
      attributes: {},
    });
  });

  it("read / readText: 範囲を分けて読み、つなげて返す", async () => {
    const bytes = new TextEncoder().encode("こんにちは");
    const assetRead = vi.fn(
      async (
        _ext: string,
        _id: string,
        offset: number,
        length: number | null,
      ) => [...bytes.slice(offset, offset + Math.min(length ?? 4, 4))],
    );
    const { call } = setup({ ipc: { assetRead } });
    const whole = (await call("assets.read", ["a1"])) as ArrayBuffer;
    expect(new Uint8Array(whole)).toEqual(bytes);
    expect(assetRead.mock.calls.length).toBeGreaterThan(1);
    const part = (await call("assets.read", [
      "a1",
      { offset: 3, length: 3 },
    ])) as ArrayBuffer;
    expect(new Uint8Array(part)).toEqual(bytes.slice(3, 6));
    await expect(call("assets.readText", ["a1"])).resolves.toBe("こんにちは");
  });

  it("read: 読み取りの合計に上限がある（巨大な読み出しは ValidationFailed）", async () => {
    const assetRead = vi.fn(async () => new Array<number>(1024).fill(1));
    const { call } = setup({ ipc: { assetRead } });
    await expect(
      call("assets.read", ["a1", { offset: 0, length: 1e12 }]),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
  });
});

describe("annotations / relations / groups の query", () => {
  it("annotations.query: Annotation の形（selector は JSON から）で返し、条件を IPC の形にする", async () => {
    const annotationsQuery = vi.fn(async () => [annotation]);
    const { call } = setup({ ipc: { annotationsQuery } });
    const result = await call("annotations.query", [
      { assetId: "a1", itemKey: "page:3", types: ["t/x"], limit: 10 },
    ]);
    expect(annotationsQuery).toHaveBeenCalledWith("com.example.a", {
      asset_id: "a1",
      item_key: "page:3",
      types: ["t/x"],
      label_ids: [],
      ids: [],
      limit: 10,
      offset: null,
    });
    expect(result).toEqual([
      {
        id: "n1",
        target: { assetId: "a1", itemKey: "page:3" },
        type: "com.example.shape/rect",
        typeVersion: 2,
        selector: { x: 1, y: 2 },
        labelId: "l1",
        attributes: { note: "x" },
        summary: "矩形",
        zOrder: 4,
        source: "com.example.a",
        createdAt: 100,
        updatedAt: 200,
      },
    ]);
  });

  it("annotations.query: アイテムが無いときは target に itemKey を入れない", async () => {
    const { call } = setup({
      ipc: {
        annotationsQuery: vi.fn(async () => [
          { ...annotation, item_key: null },
        ]),
      },
    });
    const [result] = (await call("annotations.query", [{}])) as {
      target: object;
    }[];
    expect(result?.target).toEqual({ assetId: "a1" });
  });

  it("annotations.query: 引数が配列でない・条件の型が違うときは ValidationFailed", async () => {
    const { call } = setup();
    await expect(call("annotations.query", "nope")).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    await expect(
      call("annotations.query", [{ types: "nope" }]),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(
      call("annotations.query", [{ limit: -1 }]),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it("relations.query / groups.query: 形を直して返す", async () => {
    const { call, ipc } = setup({
      ipc: {
        relationsQuery: vi.fn(async () => [
          {
            id: "r1",
            type: "t/link",
            from_id: "n1",
            to_id: "n2",
            directed: true,
            label_id: null,
            attributes_json: '{"w":1}',
            source: "manual",
          },
        ]),
        groupsQuery: vi.fn(async () => [
          {
            id: "g1",
            type: "t/track",
            ordered: true,
            label_id: "l1",
            attributes_json: "{}",
            source: "manual",
            member_ids: ["n2", "n1"],
          },
        ]),
      },
    });
    await expect(
      call("relations.query", [{ annotationIds: ["n1"] }]),
    ).resolves.toEqual([
      {
        id: "r1",
        type: "t/link",
        fromId: "n1",
        toId: "n2",
        directed: true,
        labelId: null,
        attributes: { w: 1 },
        source: "manual",
      },
    ]);
    expect(ipc.relationsQuery).toHaveBeenCalledWith("com.example.a", {
      annotation_ids: ["n1"],
      asset_id: null,
      types: [],
    });
    await expect(call("groups.query", [{ assetId: "a1" }])).resolves.toEqual([
      {
        id: "g1",
        type: "t/track",
        ordered: true,
        memberIds: ["n2", "n1"],
        labelId: "l1",
        attributes: {},
        source: "manual",
      },
    ]);
  });
});

describe("labels", () => {
  const labels = [
    {
      id: "l1",
      name: "cat",
      name_i18n_json: '{"ja":"ねこ","en":"Cat"}',
      color: "#ff0000",
      hotkey: 1,
      sort_order: 0,
      hidden: false,
      applies_to_json: '{"annotationTypes":["t/rect"]}',
    },
    {
      id: "l2",
      name: "dog",
      name_i18n_json: "{}",
      color: "#00ff00",
      hotkey: null,
      sort_order: 1,
      hidden: true,
      applies_to_json: "{}",
    },
  ];

  it("list: Label の形にし、表示名は言語で選ぶ。非表示は includeHidden のときだけ", async () => {
    const { call } = setup({
      ipc: { labelsList: vi.fn(async () => labels) },
    });
    const visible = (await call("labels.list", [])) as { id: string }[];
    expect(visible.map((l) => l.id)).toEqual(["l1"]);
    expect(visible[0]).toEqual({
      id: "l1",
      name: "cat",
      displayName: "ねこ",
      color: "#ff0000",
      hotkey: 1,
      hidden: false,
      appliesTo: { annotationTypes: ["t/rect"] },
    });
    const all = (await call("labels.list", [{ includeHidden: true }])) as {
      id: string;
      displayName: string;
    }[];
    expect(all.map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(all[1]?.displayName).toBe("dog");
  });

  it("list: 種別で絞る（appliesTo が空のラベルは、どの種別にも付けられる）", async () => {
    const { call } = setup({
      ipc: { labelsList: vi.fn(async () => labels) },
    });
    const forOther = (await call("labels.list", [
      { annotationType: "t/other", includeHidden: true },
    ])) as { id: string }[];
    expect(forOther.map((l) => l.id)).toEqual(["l2"]);
    const forRect = (await call("labels.list", [
      { annotationType: "t/rect" },
    ])) as { id: string }[];
    expect(forRect.map((l) => l.id)).toEqual(["l1"]);
  });

  it("attributeSchema: global・種別・ラベルの順に合成する", async () => {
    const { call } = setup({
      ipc: {
        schemasList: vi.fn(async () => [
          {
            scope: "global",
            target: "",
            schema_json: JSON.stringify({
              type: "object",
              properties: { a: { type: "string" }, b: { type: "string" } },
              required: ["a"],
            }),
          },
          {
            scope: "annotation_type",
            target: "t/rect",
            schema_json: JSON.stringify({
              type: "object",
              properties: { b: { type: "number" }, c: { type: "boolean" } },
              required: ["c"],
            }),
          },
          {
            scope: "label",
            target: "l1",
            schema_json: JSON.stringify({
              type: "object",
              properties: { d: { type: "integer" } },
            }),
          },
          { scope: "label", target: "l2", schema_json: "{}" },
        ]),
      },
    });
    await expect(
      call("labels.attributeSchema", [
        { labelId: "l1", annotationType: "t/rect" },
      ]),
    ).resolves.toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "number" },
        c: { type: "boolean" },
        d: { type: "integer" },
      },
      required: ["a", "c"],
    });
    await expect(call("labels.attributeSchema", [{}])).resolves.toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    });
  });
});
