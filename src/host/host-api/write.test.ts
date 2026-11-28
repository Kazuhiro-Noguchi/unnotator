import { describe, expect, it, vi } from "vitest";
import type { HostIpc } from "./ipc";
import { createManifestIndex } from "./manifests";
import { gateAllowing, setup } from "./test-support";

const EXT = "com.example.a";
const manifest = JSON.stringify({
  id: EXT,
  contributes: {
    annotationTypes: [{ id: "rect", version: 3 }],
    itemProviders: [{ id: "pages" }],
  },
});
const manifests = createManifestIndex(() => [{ id: EXT, manifest }]);

const changeSet = { seq: 9, origin: "apply", changes: [], asset_ids: [] };

function writeSetup(
  ipc: Partial<HostIpc> = {},
  gate?: ReturnType<typeof gateAllowing>,
) {
  const applyCommand = vi.fn(async () => changeSet);
  const t = setup({
    manifests,
    ...(gate === undefined ? {} : { gate }),
    ipc: { applyCommand, ...ipc },
  });
  return { ...t, applyCommand };
}

type Cmd = Record<string, unknown> & { kind: string };
const sent = (applyCommand: ReturnType<typeof vi.fn>): Cmd[] =>
  applyCommand.mock.calls.map((c) => (c as unknown[])[1] as Cmd);

describe("annotations.create", () => {
  it("create_annotation のコマンドにして apply_command へ送り、Annotation を返す。source は拡張機能 ID", async () => {
    const { call, applyCommand } = writeSetup();
    const created = (await call("annotations.create", [
      {
        target: { assetId: "a1", itemKey: "page:3" },
        type: `${EXT}/rect`,
        selector: { x: 1 },
        labelId: "l1",
        attributes: { k: "v" },
        zOrder: 4,
        // 拡張機能が source を名乗っても無視する
        source: "manual",
      },
    ])) as Record<string, unknown>;
    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect((applyCommand.mock.calls[0] as unknown[])[0]).toBe(EXT);
    const [command] = sent(applyCommand);
    expect(command).toMatchObject({
      kind: "create_annotation",
      target: {
        asset_id: "a1",
        item: {
          asset_id: "a1",
          item_key: "page:3",
          provider: `${EXT}/pages`,
        },
      },
      type: `${EXT}/rect`,
      type_version: 3,
      selector_json: '{"x":1}',
      label_id: "l1",
      attributes_json: '{"k":"v"}',
      z_order: 4,
      source: EXT,
    });
    expect(typeof command?.id).toBe("string");
    expect(String(command?.id).length).toBeGreaterThan(10);
    expect(created).toMatchObject({
      id: command?.id,
      type: `${EXT}/rect`,
      typeVersion: 3,
      selector: { x: 1 },
      labelId: "l1",
      attributes: { k: "v" },
      zOrder: 4,
      source: EXT,
      target: { assetId: "a1", itemKey: "page:3" },
    });
  });

  it("アセット全体への作成は、item を付けない", async () => {
    const { call, applyCommand } = writeSetup();
    await call("annotations.create", [
      { target: { assetId: "a1" }, type: "core/classification", selector: {} },
    ]);
    expect(sent(applyCommand)[0]?.target).toEqual({
      asset_id: "a1",
      item: null,
    });
  });

  it("引数が不正なら ValidationFailed で、何も送らない", async () => {
    const { call, applyCommand } = writeSetup();
    for (const bad of [
      {},
      { target: { assetId: "a1" }, type: "noslash", selector: {} },
      { target: {}, type: `${EXT}/rect`, selector: {} },
      { target: { assetId: "a1" }, type: `${EXT}/rect` },
      {
        target: { assetId: "a1" },
        type: `${EXT}/rect`,
        selector: {},
        zOrder: 1.5,
      },
      {
        target: { assetId: "a1" },
        type: `${EXT}/rect`,
        selector: {},
        attributes: [],
      },
    ]) {
      await expect(call("annotations.create", [bad])).rejects.toMatchObject({
        code: "ValidationFailed",
      });
    }
    expect(applyCommand).not.toHaveBeenCalled();
  });

  it("Rust が拒否したら、そのエラーを返す（NotFound など）", async () => {
    const { call } = writeSetup({
      applyCommand: vi.fn(async () => {
        throw { code: "not_found", message: "asset" };
      }),
    });
    await expect(
      call("annotations.create", [
        { target: { assetId: "zz" }, type: `${EXT}/rect`, selector: {} },
      ]),
    ).rejects.toMatchObject({ code: "NotFound" });
  });
});

describe("annotations.update / remove", () => {
  const row = {
    id: "n1",
    asset_id: "a1",
    item_key: null,
    type: `${EXT}/rect`,
    type_version: 3,
    selector_json: "{}",
    label_id: "l1",
    attributes_json: '{"a":1,"b":2}',
    summary: "",
    z_order: 0,
    source: EXT,
    created_at: 1,
    updated_at: 1,
  };

  it("selector・labelId・zOrder のパッチ（labelId の null は空にする）。読み取りは要らない", async () => {
    const annotationsQuery = vi.fn(async () => [row]);
    const { call, applyCommand } = writeSetup({ annotationsQuery });
    await call("annotations.update", [
      "n1",
      { selector: { x: 2 }, labelId: null, zOrder: 7 },
    ]);
    expect(annotationsQuery).not.toHaveBeenCalled();
    expect(sent(applyCommand)[0]).toEqual({
      kind: "update_annotation",
      id: "n1",
      patch: {
        selector_json: { kind: "set", value: '{"x":2}' },
        label_id: { kind: "clear" },
        z_order: { kind: "set", value: 7 },
      },
    });
  });

  it("attributes は部分更新（指定したキーだけ置き換え、null でキー削除）。現在の値を読む", async () => {
    const annotationsQuery = vi.fn(async () => [row]);
    const { call, applyCommand } = writeSetup({ annotationsQuery });
    await call("annotations.update", ["n1", { attributes: { b: null, c: 3 } }]);
    expect(annotationsQuery).toHaveBeenCalledWith(
      EXT,
      expect.objectContaining({ ids: ["n1"] }),
    );
    expect(sent(applyCommand)[0]).toMatchObject({
      patch: { attributes_json: { kind: "set", value: '{"a":1,"c":3}' } },
    });
  });

  it("存在しないアノテーションの更新は NotFound（書かない）", async () => {
    const { call, applyCommand } = writeSetup({
      annotationsQuery: vi.fn(async () => []),
    });
    await expect(
      call("annotations.update", ["zz", { attributes: { a: 1 } }]),
    ).rejects.toMatchObject({ code: "NotFound" });
    expect(applyCommand).not.toHaveBeenCalled();
  });

  it("selector を変えたとき、読み取りの権限が無ければ、ダイアログを経て PermissionDenied", async () => {
    const { call, applyCommand } = writeSetup(
      { annotationsQuery: vi.fn(async () => [row]) },
      gateAllowing("annotations.write"),
    );
    await expect(
      call("annotations.update", ["n1", { attributes: { a: 1 } }]),
    ).rejects.toMatchObject({ code: "PermissionDenied" });
    expect(applyCommand).not.toHaveBeenCalled();
  });

  it("remove: 1 件は delete_annotation、複数は 1 つの transaction（1 回の Undo）", async () => {
    const { call, applyCommand } = writeSetup();
    await call("annotations.remove", [["n1"]]);
    await call("annotations.remove", [["n1", "n2"]]);
    expect(sent(applyCommand)).toEqual([
      { kind: "delete_annotation", id: "n1" },
      {
        kind: "transaction",
        commands: [
          { kind: "delete_annotation", id: "n1" },
          { kind: "delete_annotation", id: "n2" },
        ],
      },
    ]);
  });

  it("remove: 空の配列は何もしない。配列でなければ ValidationFailed", async () => {
    const { call, applyCommand } = writeSetup();
    await call("annotations.remove", [[]]);
    expect(applyCommand).not.toHaveBeenCalled();
    await expect(call("annotations.remove", ["n1"])).rejects.toMatchObject({
      code: "ValidationFailed",
    });
  });
});

describe("annotations.transaction（FR-016）", () => {
  const create = (n: number) => [
    { target: { assetId: "a1" }, type: `${EXT}/rect`, selector: { n } },
  ];

  it("begin → 中の書き込み → commit で、1 つの Transaction として 1 回だけ送る", async () => {
    const { call, applyCommand } = writeSetup();
    await call("annotations.transaction", { op: "begin", label: "取り込み" });
    const a = (await call("annotations.create", create(1))) as { id: string };
    await call("annotations.create", create(2));
    await call("relations.create", [
      { type: `${EXT}/link`, fromId: a.id, toId: "n9" },
    ]);
    expect(applyCommand).not.toHaveBeenCalled();
    await call("annotations.transaction", { op: "commit" });
    expect(applyCommand).toHaveBeenCalledTimes(1);
    const [command] = sent(applyCommand);
    expect(command?.kind).toBe("transaction");
    const inner = command?.commands as Cmd[];
    expect(inner.map((c) => c.kind)).toEqual([
      "create_annotation",
      "create_annotation",
      "create_relation",
    ]);
    // 中のコマンドが、前に作ったものの ID を参照できる
    expect(inner[2]?.from_id).toBe(a.id);
    expect(inner.every((c) => c.source === EXT)).toBe(true);
  });

  it("abort で、何も送らない（途中の失敗で何も残さない）", async () => {
    const { call, applyCommand } = writeSetup();
    await call("annotations.transaction", { op: "begin", label: "x" });
    await call("annotations.create", create(1));
    await call("annotations.transaction", { op: "abort" });
    expect(applyCommand).not.toHaveBeenCalled();
    // abort のあとは、また普通に書ける
    await call("annotations.create", create(2));
    expect(applyCommand).toHaveBeenCalledTimes(1);
  });

  it("commit が Rust で失敗したら、そのエラーを返し、バッファは捨てる", async () => {
    const applyCommand = vi
      .fn()
      .mockRejectedValueOnce({ code: "invalid_command", message: "bad" })
      .mockResolvedValue(changeSet);
    const { call } = writeSetup({ applyCommand });
    await call("annotations.transaction", { op: "begin", label: "x" });
    await call("annotations.create", create(1));
    await expect(
      call("annotations.transaction", { op: "commit" }),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    // 開きっぱなしにならない
    await call("annotations.transaction", { op: "begin", label: "y" });
  });

  it("入れ子・begin なしの commit・不正な op は ValidationFailed", async () => {
    const { call } = writeSetup();
    await expect(
      call("annotations.transaction", { op: "commit" }),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(
      call("annotations.transaction", { op: "nope" }),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await call("annotations.transaction", { op: "begin", label: "x" });
    await expect(
      call("annotations.transaction", { op: "begin", label: "y" }),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it("空の transaction は何も送らない。件数の上限を超えたら ValidationFailed", async () => {
    const { call, applyCommand } = writeSetup();
    await call("annotations.transaction", { op: "begin", label: "x" });
    await call("annotations.transaction", { op: "commit" });
    expect(applyCommand).not.toHaveBeenCalled();
    await call("annotations.transaction", { op: "begin", label: "x" });
    let failure: unknown;
    for (let i = 0; i < 10_001 && failure === undefined; i++) {
      await call("annotations.create", create(i)).catch((e) => {
        failure = e;
      });
    }
    expect(failure).toMatchObject({ code: "ValidationFailed" });
  });

  it("transaction は拡張機能ごと（別の拡張機能の書き込みは、巻き込まない）", async () => {
    const { call, applyCommand } = writeSetup();
    await call("annotations.transaction", { op: "begin", label: "x" });
    await call("annotations.create", create(1), "com.example.other");
    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect((applyCommand.mock.calls[0] as unknown[])[0]).toBe(
      "com.example.other",
    );
  });

  it("枠が取り除かれたら、開いている transaction は捨てる", async () => {
    const { api, call, applyCommand } = writeSetup();
    await call("annotations.transaction", { op: "begin", label: "x" });
    await call("annotations.create", create(1));
    api.closeExtension(EXT);
    await call("annotations.create", create(2));
    expect(applyCommand).toHaveBeenCalledTimes(1);
  });
});

describe("relations / groups", () => {
  it("relations.create: create_relation（source は拡張機能 ID）。update は属性の部分更新・labelId の null で空に", async () => {
    const { call, applyCommand } = writeSetup({
      relationsQuery: vi.fn(async () => [
        {
          id: "r1",
          type: "t/l",
          from_id: "a",
          to_id: "b",
          directed: true,
          label_id: null,
          attributes_json: '{"w":1}',
          source: "manual",
        },
      ]),
    });
    const created = await call("relations.create", [
      {
        type: "t/link",
        fromId: "n1",
        toId: "n2",
        labelId: "l1",
        attributes: { w: 1 },
      },
    ]);
    expect(created).toMatchObject({
      type: "t/link",
      fromId: "n1",
      toId: "n2",
      directed: true,
      labelId: "l1",
      attributes: { w: 1 },
      source: EXT,
    });
    await call("relations.update", [
      "r1",
      { labelId: null, attributes: { w: null, z: 2 } },
    ]);
    await call("relations.remove", [["r1"]]);
    expect(sent(applyCommand)).toMatchObject([
      {
        kind: "create_relation",
        type: "t/link",
        from_id: "n1",
        to_id: "n2",
        label_id: "l1",
        attributes_json: '{"w":1}',
        source: EXT,
      },
      {
        kind: "update_relation",
        patch: {
          label_id: { kind: "clear" },
          attributes_json: { kind: "set", value: '{"z":2}' },
        },
      },
      { kind: "delete_relation", id: "r1" },
    ]);
  });

  it("groups.create / update / remove", async () => {
    const { call, applyCommand } = writeSetup({
      groupsQuery: vi.fn(async () => [
        {
          id: "g1",
          type: "t/track",
          ordered: false,
          label_id: null,
          attributes_json: "{}",
          source: "manual",
          member_ids: [],
        },
      ]),
    });
    const created = await call("groups.create", [
      { type: "t/track", memberIds: ["n1", "n2"] },
    ]);
    expect(created).toMatchObject({
      type: "t/track",
      memberIds: ["n1", "n2"],
      source: EXT,
    });
    await call("groups.update", ["g1", { labelId: "l2" }]);
    await call("groups.remove", [["g1"]]);
    expect(sent(applyCommand)).toMatchObject([
      {
        kind: "create_group",
        type: "t/track",
        members: ["n1", "n2"],
        source: EXT,
      },
      {
        kind: "update_group",
        id: "g1",
        patch: { label_id: { kind: "set", value: "l2" } },
      },
      { kind: "delete_group", id: "g1" },
    ]);
  });

  it("groups.setMembers: 現在のメンバーとの差から、外す・足す・動かすのコマンドにする", async () => {
    const { call, applyCommand } = writeSetup({
      groupsQuery: vi.fn(async () => [
        {
          id: "g1",
          type: "t/track",
          ordered: true,
          label_id: null,
          attributes_json: "{}",
          source: "manual",
          member_ids: ["n1", "n2", "n3"],
        },
      ]),
    });
    // n2 を外し、n4 を先頭に足し、n3 と n1 を入れ替える → [n4, n3, n1]
    await call("groups.setMembers", ["g1", ["n4", "n3", "n1"]]);
    const [command] = sent(applyCommand);
    expect(command?.kind).toBe("transaction");
    const inner = (command?.commands ?? []) as Cmd[];
    const kinds = inner.map((c) => c.kind);
    expect(kinds[0]).toBe("remove_group_members");
    expect(kinds).toContain("add_group_members");
    // 適用後の並びを、コマンドの列から再現して確かめる
    let members = ["n1", "n2", "n3"];
    for (const c of inner) {
      if (c.kind === "remove_group_members")
        members = members.filter(
          (m) => !(c.annotation_ids as string[]).includes(m),
        );
      else if (c.kind === "add_group_members")
        members.splice(
          (c.at as number | null) ?? members.length,
          0,
          ...(c.annotation_ids as string[]),
        );
      else if (c.kind === "move_group_member") {
        members = members.filter((m) => m !== c.annotation_id);
        members.splice(c.to_position as number, 0, c.annotation_id as string);
      }
    }
    expect(members).toEqual(["n4", "n3", "n1"]);
  });

  it("groups.setMembers: 変わらなければ何も送らない。グループが無ければ NotFound", async () => {
    const same = writeSetup({
      groupsQuery: vi.fn(async () => [
        {
          id: "g1",
          type: "t/track",
          ordered: true,
          label_id: null,
          attributes_json: "{}",
          source: "manual",
          member_ids: ["n1"],
        },
      ]),
    });
    await same.call("groups.setMembers", ["g1", ["n1"]]);
    expect(same.applyCommand).not.toHaveBeenCalled();
    const none = writeSetup({ groupsQuery: vi.fn(async () => []) });
    await expect(
      none.call("groups.setMembers", ["zz", []]),
    ).rejects.toMatchObject({
      code: "NotFound",
    });
  });
});

describe("assets.setMetadata / setStatus", () => {
  it("アセットとアイテムのメタ情報（名前空間は拡張機能 ID）と、作業状態", async () => {
    const { call, applyCommand } = writeSetup();
    await call("assets.setMetadata", ["a1", { width: 10 }]);
    await call("assets.setMetadata", ["a1", { page: 3 }, "page:3"]);
    await call("assets.setStatus", [{ assetId: "a1" }, "done"]);
    await call("assets.setStatus", [
      { assetId: "a1", itemKey: "page:3" },
      "review",
    ]);
    expect(sent(applyCommand)).toEqual([
      {
        kind: "set_asset_metadata",
        asset_id: "a1",
        namespace: EXT,
        metadata_json: '{"width":10}',
      },
      {
        kind: "set_item_metadata",
        item: { asset_id: "a1", item_key: "page:3", provider: `${EXT}/pages` },
        namespace: EXT,
        metadata_json: '{"page":3}',
      },
      { kind: "set_asset_status", asset_id: "a1", status: "done" },
      {
        kind: "set_item_status",
        item: { asset_id: "a1", item_key: "page:3", provider: `${EXT}/pages` },
        status: "review",
      },
    ]);
  });

  it("不正な状態・メタ情報は ValidationFailed", async () => {
    const { call, applyCommand } = writeSetup();
    await expect(
      call("assets.setStatus", [{ assetId: "a1" }, "finished"]),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(
      call("assets.setMetadata", ["a1", [1, 2]]),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(applyCommand).not.toHaveBeenCalled();
  });

  it("権限が無いと、書き込みの前に PermissionDenied", async () => {
    const { call, applyCommand } = writeSetup({}, gateAllowing("assets.read"));
    await expect(call("assets.setMetadata", ["a1", {}])).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    await expect(
      call("assets.setStatus", [{ assetId: "a1" }, "done"]),
    ).rejects.toMatchObject({ code: "PermissionDenied" });
    expect(applyCommand).not.toHaveBeenCalled();
  });
});
