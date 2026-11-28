// Host API の各部（read・write・events・misc）が共有する型。
import type { ChangeSetDto, HostIpc } from "./ipc";
import type { ManifestIndex } from "./manifests";
import type { PermissionGate } from "./permissions";
import type { HostState } from "./state";

export interface HostApiDeps {
  ipc: HostIpc;
  gate: PermissionGate;
  state: HostState;
  /** 言語（`ja` / `en`）。ラベルの表示名などに使う。 */
  locale(): string;
  /** マニフェストの宣言（種別・アイテム提供の名前など）。 */
  manifests: ManifestIndex;
  /** 書き込みが済んだとき（通知にコマンドの表示名を結ぶ）。 */
  onApplied?(set: ChangeSetDto, name: string): void;
}

export interface Ctx {
  extId: string;
  ipc: HostIpc;
  deps: HostApiDeps;
}

export type Handler = (ctx: Ctx, args: unknown) => Promise<unknown>;
export type Handlers = Record<string, Handler>;
