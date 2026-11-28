import { describe, expect, it, vi } from "vitest";
import { createChangeBridge, toChangeEvent } from "./events";
import type { ChangeSetDto } from "./ipc";

const set = (
  changes: ChangeSetDto["changes"],
  origin = "apply",
  assetIds: string[] = ["a1"],
): ChangeSetDto => ({ seq: 1, origin, changes, asset_ids: assetIds });

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("ChangeSet → ChangeEvent", () => {
  it("エンティティごとに created / updated / deleted の ID に分ける", () => {
    const event = toChangeEvent(
      set([
        { entity: "annotation", id: "n1", kind: "created" },
        { entity: "annotation", id: "n2", kind: "updated" },
        { entity: "annotation", id: "n3", kind: "deleted" },
        { entity: "relation", id: "r1", kind: "created" },
        { entity: "group", id: "g1", kind: "deleted" },
      ]),
      "追加",
    );
    expect(event).toEqual({
      label: "追加",
      cause: "command",
      annotations: { created: ["n1"], updated: ["n2"], deleted: ["n3"] },
      relations: { created: ["r1"], updated: [], deleted: [] },
      groups: { created: [], updated: [], deleted: ["g1"] },
      assetIds: ["a1"],
    });
  });

  it("グループの所属の変更は、グループの更新として数える（重複しない）", () => {
    const event = toChangeEvent(
      set([
        { entity: "group_member", id: "g1/n1", kind: "created" },
        { entity: "group_member", id: "g1/n2", kind: "created" },
        { entity: "group", id: "g1", kind: "updated" },
      ]),
    );
    expect(event.groups.updated).toEqual(["g1"]);
  });

  it("origin を cause にする（undo・redo・sync は external）", () => {
    expect(toChangeEvent(set([], "undo")).cause).toBe("undo");
    expect(toChangeEvent(set([], "redo")).cause).toBe("redo");
    expect(toChangeEvent(set([], "sync")).cause).toBe("external");
    expect(toChangeEvent(set([], "weird")).cause).toBe("external");
  });
});

describe("通知の配り先", () => {
  function setup(granted: string[] = ["annotations.read", "labels.read"]) {
    return createChangeBridge({
      allowed: async (_id, permission) => granted.includes(permission),
    });
  }

  it("シェルの購読者と、購読している枠の両方へ届く", async () => {
    const bridge = setup();
    const shell = vi.fn();
    const frame = vi.fn();
    bridge.subscribe(shell);
    bridge.attach("com.example.a", frame);
    bridge.publish(set([{ entity: "annotation", id: "n1", kind: "created" }]));
    await tick();
    expect(shell).toHaveBeenCalledTimes(1);
    expect(frame).toHaveBeenCalledWith(
      "annotations.change",
      expect.objectContaining({
        annotations: { created: ["n1"], updated: [], deleted: [] },
      }),
    );
  });

  it("枠を取り除く（detach）と、その枠へは届かない。シェルへは届き続ける", async () => {
    const bridge = setup();
    const shell = vi.fn();
    const frame = vi.fn();
    bridge.subscribe(shell);
    const detach = bridge.attach("com.example.a", frame);
    detach();
    bridge.publish(set([{ entity: "annotation", id: "n1", kind: "created" }]));
    await tick();
    expect(frame).not.toHaveBeenCalled();
    expect(shell).toHaveBeenCalledTimes(1);
  });

  it("権限の確認の最中に枠を取り除いても、その枠へは届かない", async () => {
    const bridge = setup();
    const frame = vi.fn();
    const detach = bridge.attach("com.example.a", frame);
    bridge.publish(set([{ entity: "annotation", id: "n1", kind: "created" }]));
    detach();
    await tick();
    expect(frame).not.toHaveBeenCalled();
  });

  it("シェルの購読を外すと届かない", async () => {
    const bridge = setup();
    const shell = vi.fn();
    const off = bridge.subscribe(shell);
    off();
    bridge.publish(set([{ entity: "annotation", id: "n1", kind: "created" }]));
    await tick();
    expect(shell).not.toHaveBeenCalled();
  });

  it("annotations.read が無い拡張機能には、アノテーションの変更を届けない", async () => {
    const bridge = setup(["labels.read"]);
    const frame = vi.fn();
    bridge.attach("com.example.a", frame);
    bridge.publish(set([{ entity: "annotation", id: "n1", kind: "created" }]));
    await tick();
    expect(frame).not.toHaveBeenCalled();
  });

  it("アノテーション・関係・グループのどれも変わらない通知は、枠へ届けない", async () => {
    const bridge = setup();
    const frame = vi.fn();
    bridge.attach("com.example.a", frame);
    bridge.publish(set([{ entity: "asset", id: "a1", kind: "updated" }]));
    await tick();
    expect(frame).not.toHaveBeenCalled();
  });

  it("ラベル・属性スキーマの変更は labels.change として、labels.read のある枠へ届く", async () => {
    const bridge = setup(["labels.read"]);
    const frame = vi.fn();
    bridge.attach("com.example.a", frame);
    bridge.publish(set([{ entity: "label", id: "l1", kind: "updated" }]));
    await tick();
    expect(frame).toHaveBeenCalledWith("labels.change", null);
  });

  it("購読者の例外は、ほかの購読者に影響しない", async () => {
    const bridge = setup();
    const good = vi.fn();
    bridge.subscribe(() => {
      throw new Error("x");
    });
    bridge.subscribe(good);
    bridge.attach("com.example.a", () => {
      throw new Error("y");
    });
    bridge.publish(set([{ entity: "annotation", id: "n1", kind: "created" }]));
    await tick();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("コマンドの表示名（noteLabel）を、同じ通し番号の通知に付ける", async () => {
    const bridge = setup();
    const shell = vi.fn();
    bridge.subscribe(shell);
    bridge.noteLabel(7, "create_annotation");
    bridge.publish({
      ...set([{ entity: "annotation", id: "n1", kind: "created" }]),
      seq: 7,
    });
    await tick();
    expect(shell.mock.calls[0]?.[0].label).toBe("create_annotation");
  });
});
