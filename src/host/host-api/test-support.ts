// Host API のテスト用の部品（本番では使わない）。
import { vi } from "vitest";
import { Registrations } from "../activation";
import type { HostRequest } from "../channel";
import { createHostApi, type HostApi, type HostApiDeps } from "./api";
import type { ShellPort } from "./api-types";
import type { HostIpc } from "./ipc";
import { createManifestIndex } from "./manifests";
import { createPermissionGate, type PermissionGate } from "./permissions";
import { createHostState } from "./state";

export const EXT = "com.example.a";

/** すべての呼び出しが失敗する IPC。テストが必要なものだけ差し替える。 */
export function fakeIpc(overrides: Partial<HostIpc> = {}): HostIpc {
  const unexpected = (name: string) =>
    vi.fn(async () => {
      throw new Error(`unexpected ipc call: ${name}`);
    });
  const names = [
    "checkPermission",
    "consent",
    "assetGet",
    "internalAsset",
    "itemGet",
    "assetRead",
    "annotationsQuery",
    "relationsQuery",
    "groupsQuery",
    "labelsList",
    "schemasList",
    "applyCommand",
    "storageGet",
    "storageSet",
    "projectFileRead",
    "projectFileWrite",
    "log",
  ] as const;
  const base = Object.fromEntries(
    names.map((n) => [n, unexpected(n)]),
  ) as unknown as HostIpc;
  return { ...base, ...overrides };
}

/** すべての権限を許す門。 */
export function openGate(): PermissionGate {
  return createPermissionGate({
    checkPermission: async () => ({ verdict: "allowed", warning: false }),
    consent: async () => {},
    ask: async () => true,
  });
}

/** 指定した権限だけ許す門（それ以外は宣言なし）。 */
export function gateAllowing(...allowed: string[]): PermissionGate {
  return createPermissionGate({
    checkPermission: async (_id, permission) => ({
      verdict: allowed.includes(permission) ? "allowed" : "denied",
      warning: false,
    }),
    consent: async () => {},
    ask: async () => true,
  });
}

/** 何もしないシェル。必要な関数だけ差し替える。 */
export function fakeShell(overrides: Partial<ShellPort> = {}): ShellPort {
  return {
    notify: vi.fn(),
    confirm: vi.fn(async () => true),
    setStatusBarItem: vi.fn(),
    showView: vi.fn(),
    setContext: vi.fn(),
    provideCommand: vi.fn(() => ({ dispose: vi.fn() })),
    executeCommand: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

export function setup(
  overrides: Omit<Partial<HostApiDeps>, "ipc"> & {
    ipc?: Partial<HostIpc>;
  } = {},
): {
  api: HostApi;
  ipc: HostIpc;
  state: ReturnType<typeof createHostState>;
  call: (m: string, a?: unknown, extId?: string) => Promise<unknown>;
} {
  const ipc = fakeIpc(overrides.ipc);
  const state = overrides.state ?? createHostState();
  const api = createHostApi({
    gate: openGate(),
    locale: () => "ja",
    manifests: createManifestIndex(() => []),
    registrations: (
      (regs) => () =>
        regs
    )(new Registrations()),
    members: new Map(),
    shell: fakeShell(),
    callFrame: vi.fn(async () => null),
    ...overrides,
    ipc,
    state,
  });
  const call = (m: string, a: unknown = [], extId = EXT) =>
    api.handle({ extId, m, a } satisfies HostRequest);
  return { api, ipc, state, call };
}
