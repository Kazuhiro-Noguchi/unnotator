import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import table from "../../../crates/extensions/host-api-permissions.json";
import { HOST_METHODS } from "../frames";
import {
  createPermissionGate,
  HostApiError,
  type PermissionDeps,
  requiredPermission,
} from "./permissions";

function setup(
  verdicts: Record<string, "allowed" | "needs_consent" | "denied">,
  answer = true,
) {
  const state = { ...verdicts };
  const deps: PermissionDeps = {
    checkPermission: vi.fn(async (_id: string, permission: string) => ({
      verdict: state[permission] ?? "denied",
      warning: permission === "network",
    })),
    consent: vi.fn(async (_id: string, permissions: string[]) => {
      for (const p of permissions) state[p] = "allowed";
    }),
    ask: vi.fn(async () => answer),
  };
  return { deps, gate: createPermissionGate(deps), state };
}

const ID = "com.example.a";

describe("権限の表", () => {
  it("TS が読む表（permissions）は、マニフェストのスキーマの権限の列挙と一致する", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL(
          "../../../crates/extensions/schema/unnotator-plugin.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { properties: { permissions: { items: { enum: string[] } } } };
    expect([...table.permissions].sort()).toEqual(
      [...schema.properties.permissions.items.enum].sort(),
    );
  });

  it("methods の権限は、すべて permissions の中にある。枠から受ける名前の表と同じ", () => {
    for (const permission of Object.values(table.methods)) {
      if (permission !== null) expect(table.permissions).toContain(permission);
    }
    expect([...HOST_METHODS].sort()).toEqual(Object.keys(table.methods).sort());
  });

  it("requiredPermission: 権限が要るもの・要らないもの・表にないもの", () => {
    expect(requiredPermission("annotations.create")).toBe("annotations.write");
    expect(requiredPermission("selection.get")).toBeNull();
    expect(requiredPermission("nope.nope")).toBeUndefined();
  });
});

describe("権限の確認", () => {
  it("権限が要らないメソッドは、確認せずに通る", async () => {
    const { gate, deps } = setup({});
    await gate.authorize(ID, "selection.get");
    expect(deps.checkPermission).not.toHaveBeenCalled();
  });

  it("表にないメソッドは PermissionDenied", async () => {
    const { gate } = setup({});
    await expect(gate.authorize(ID, "evil.thing")).rejects.toMatchObject({
      code: "PermissionDenied",
    });
  });

  it("宣言なし（denied）は、ダイアログを出さずに PermissionDenied", async () => {
    const { gate, deps } = setup({ "annotations.write": "denied" });
    await expect(
      gate.authorize(ID, "annotations.create"),
    ).rejects.toBeInstanceOf(HostApiError);
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("同意済みは、そのまま通る", async () => {
    const { gate, deps } = setup({ "assets.read": "allowed" });
    await gate.authorize(ID, "assets.get");
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("未同意: ダイアログで許可すると同意が保存され、通る。次からは聞かない", async () => {
    const { gate, deps } = setup({ "assets.read": "needs_consent" });
    await gate.authorize(ID, "assets.get");
    expect(deps.ask).toHaveBeenCalledTimes(1);
    expect(deps.ask).toHaveBeenCalledWith({
      extId: ID,
      permissions: [{ permission: "assets.read", warning: false }],
    });
    expect(deps.consent).toHaveBeenCalledWith(ID, ["assets.read"]);
    await gate.authorize(ID, "assets.read");
    expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it("未同意: 拒否すると PermissionDenied で、同意は保存されない。同じ権限は続けて聞かない", async () => {
    const { gate, deps } = setup({ "assets.read": "needs_consent" }, false);
    await expect(gate.authorize(ID, "assets.get")).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    expect(deps.consent).not.toHaveBeenCalled();
    await expect(gate.authorize(ID, "assets.get")).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it("拒否のあと、同意を取り消された・付け直された（forget）ら、もう一度聞く", async () => {
    const { gate, deps } = setup({ "assets.read": "needs_consent" }, false);
    await expect(gate.authorize(ID, "assets.get")).rejects.toBeDefined();
    gate.forget(ID);
    await expect(gate.authorize(ID, "assets.get")).rejects.toBeDefined();
    expect(deps.ask).toHaveBeenCalledTimes(2);
  });

  it("同意のあと取り消す（revoke）と、次の呼び出しでもう一度聞く", async () => {
    const { gate, deps, state } = setup({ "assets.read": "needs_consent" });
    await gate.authorize(ID, "assets.get");
    state["assets.read"] = "needs_consent"; // Rust 側で取り消した
    gate.forget(ID);
    await gate.authorize(ID, "assets.get");
    expect(deps.ask).toHaveBeenCalledTimes(2);
  });

  it("同時に同じ権限を求められても、ダイアログは 1 つだけ", async () => {
    const { gate, deps } = setup({ "assets.read": "needs_consent" });
    await Promise.all([
      gate.authorize(ID, "assets.get"),
      gate.authorize(ID, "assets.read"),
      gate.authorize(ID, "assets.getItem"),
    ]);
    expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it("network の警告つきの権限は、warning を添えて聞く", async () => {
    const { gate, deps } = setup({ network: "needs_consent" });
    await gate.requirePermission(ID, "network");
    expect(deps.ask).toHaveBeenCalledWith({
      extId: ID,
      permissions: [{ permission: "network", warning: true }],
    });
  });

  it("確認の問い合わせ自体が失敗したら、通さない（既定は拒否）", async () => {
    const { gate, deps } = setup({});
    (deps.checkPermission as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("ipc down"),
    );
    await expect(gate.authorize(ID, "assets.get")).rejects.toMatchObject({
      code: "PermissionDenied",
    });
  });
});
