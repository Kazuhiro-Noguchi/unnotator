import { describe, expect, it, vi } from "vitest";
import type { Frame } from "../frames";
import { createHostApp } from "./host-app";
import { createManifestIndex } from "./manifests";
import { fakeIpc } from "./test-support";

const manifest = JSON.stringify({
  id: "com.example.a",
  permissions: ["labels.read", "assets.read"],
  contributes: {
    settings: { properties: { "a.size": { type: "number" } } },
  },
});

function setup(
  verdict: (
    permission: string,
  ) => "allowed" | "needs_consent" | "denied" = () => "allowed",
) {
  const ipc = fakeIpc({
    checkPermission: vi.fn(async (_id: string, permission: string) => ({
      verdict: verdict(permission),
      warning: false,
    })),
    consent: vi.fn(async () => {}),
  });
  const ask = vi.fn(async () => true);
  const readSetting = vi.fn(
    async (key: string): Promise<unknown> => (key === "a.size" ? 5 : undefined),
  );
  const app = createHostApp({
    ipc,
    manifests: createManifestIndex(() => [{ id: "com.example.a", manifest }]),
    locale: () => "ja",
    nameOf: (id) => id,
    ask,
    readSetting,
  });
  const frame = (): Frame =>
    ({
      extensionId: "com.example.a",
      role: "view",
      channel: { emit: vi.fn() },
    }) as unknown as Frame;
  return { app, ipc, ask, readSetting, frame };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("Host API の本体（host-app）", () => {
  it("handle: 権限の門を通って各部へ（宣言のない権限は PermissionDenied）", async () => {
    const t = setup((p) => (p === "annotations.read" ? "denied" : "allowed"));
    await expect(
      t.app.handle({ extId: "com.example.a", m: "annotations.query", a: [{}] }),
    ).rejects.toMatchObject({ code: "PermissionDenied" });
  });

  it("mirrorInit: 権限と宣言に従った最初の写し。設定は宣言したキーの現在の値", async () => {
    const t = setup();
    await t.app.refreshSettings();
    const mirror = await t.app.mirrorInit("com.example.a");
    expect(mirror.settings).toEqual({ "a.size": 5 });
    expect(mirror.selection).toEqual([]);
  });

  it("onFrameCreate: 状態の変化が、その枠の channel.emit へ届く。onFrameRemove で止まる", async () => {
    const t = setup();
    const frame = t.frame();
    t.app.onFrameCreate(frame);
    await tick();
    const emit = frame.channel.emit as ReturnType<typeof vi.fn>;
    emit.mockClear();
    t.app.state.set("selection", ["n1"]);
    await tick();
    expect(emit).toHaveBeenCalledWith("selection", ["n1"]);
    t.app.onFrameRemove(frame);
    t.app.state.set("selection", ["n2"]);
    await tick();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("onFrameCreate: 作った直後に、写しの全体を 1 度押し込む（init との行き違いを補う）", async () => {
    const t = setup();
    t.app.state.set("selection", ["x"]);
    const frame = t.frame();
    t.app.onFrameCreate(frame);
    await tick();
    expect(frame.channel.emit).toHaveBeenCalledWith("selection", ["x"]);
  });

  it("変更の通知: シェルと、作った枠の両方へ届き、枠を取り除くと枠へは届かない（FR-018）", async () => {
    const t = setup();
    const frame = t.frame();
    const shell = vi.fn();
    t.app.changes.subscribe(shell);
    t.app.onFrameCreate(frame);
    await tick();
    const emit = frame.channel.emit as ReturnType<typeof vi.fn>;
    emit.mockClear();
    const change = {
      seq: 1,
      origin: "apply",
      changes: [{ entity: "annotation", id: "n1", kind: "created" }],
      asset_ids: ["a1"],
    };
    t.app.changes.publish(change);
    await tick();
    expect(shell).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("annotations.change", expect.anything());
    t.app.onFrameRemove(frame);
    emit.mockClear();
    t.app.changes.publish({ ...change, seq: 2 });
    await tick();
    expect(shell).toHaveBeenCalledTimes(2);
    expect(emit).not.toHaveBeenCalled();
  });

  it("書き込み: transaction のあいだは溜め、commit で 1 回だけ送る。裏の枠が無くなったら捨てる", async () => {
    const applyCommand = vi.fn(async () => ({
      seq: 5,
      origin: "apply",
      changes: [],
      asset_ids: [],
    }));
    const ipc = fakeIpc({
      checkPermission: vi.fn(async () => ({
        verdict: "allowed",
        warning: false,
      })),
      applyCommand,
    });
    const app = createHostApp({
      ipc,
      manifests: createManifestIndex(() => []),
      locale: () => "ja",
      nameOf: (id) => id,
      ask: async () => true,
      readSetting: async () => undefined,
    });
    const call = (m: string, a: unknown) =>
      app.handle({ extId: "com.example.a", m, a });
    const create = [
      { target: { assetId: "a1" }, type: "core/classification", selector: {} },
    ];
    await call("annotations.transaction", { op: "begin", label: "x" });
    await call("annotations.create", create);
    expect(applyCommand).not.toHaveBeenCalled();
    app.onFrameRemove({
      extensionId: "com.example.a",
      role: "background",
      channel: { emit: vi.fn() },
    } as unknown as Frame);
    await call("annotations.create", create);
    expect(applyCommand).toHaveBeenCalledTimes(1);
  });

  it("refreshSettings: 宣言されたキーを読み直して、写しの設定を更新する", async () => {
    const t = setup();
    const frame = t.frame();
    t.app.onFrameCreate(frame);
    await tick();
    (frame.channel.emit as ReturnType<typeof vi.fn>).mockClear();
    t.readSetting.mockImplementation(async () => 9);
    await t.app.refreshSettings();
    await tick();
    expect(frame.channel.emit).toHaveBeenCalledWith("settings", {
      "a.size": 9,
    });
  });

  it("onLog: 長さを制限し、ID つきで ipc.log に渡す（失敗しても例外にしない）", async () => {
    const log = vi.fn(async () => {
      throw new Error("x");
    });
    const ipc = fakeIpc({ log });
    const app = createHostApp({
      ipc,
      manifests: createManifestIndex(() => []),
      locale: () => "ja",
      nameOf: (id) => id,
      ask: async () => true,
      readSetting: async () => undefined,
    });
    app.onLog("com.example.a", { level: "info", args: ["a".repeat(10_000)] });
    app.onLog("com.example.a", { level: "bogus", args: [1, null] });
    app.onLog("com.example.a", "not an object");
    await tick();
    const first = log.mock.calls[0] as unknown as [string, string, string];
    expect(first[0]).toBe("com.example.a");
    expect(first[1]).toBe("info");
    expect(first[2].length).toBeLessThanOrEqual(2000);
    const second = log.mock.calls[1] as unknown as [string, string, string];
    expect(second[1]).toBe("info");
  });
});
