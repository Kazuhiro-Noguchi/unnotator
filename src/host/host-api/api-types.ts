// Host API の各部（read・write・events・misc）が共有する型。
import type { HostIpc } from "./ipc";
import type { PermissionGate } from "./permissions";
import type { HostState } from "./state";

export interface HostApiDeps {
  ipc: HostIpc;
  gate: PermissionGate;
  state: HostState;
  /** 言語（`ja` / `en`）。ラベルの表示名などに使う。 */
  locale(): string;
}

export interface Ctx {
  extId: string;
  ipc: HostIpc;
  deps: HostApiDeps;
}

export type Handler = (ctx: Ctx, args: unknown) => Promise<unknown>;
export type Handlers = Record<string, Handler>;
