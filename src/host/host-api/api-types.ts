// Host API の各部（read・write・events・misc）が共有する型。
import type { Registrations } from "../activation";
import type { SuggestionStore } from "../suggestions";
import type { ChangeSetDto, HostIpc } from "./ipc";
import type { ManifestIndex } from "./manifests";
import type { PermissionGate } from "./permissions";
import type { HostState } from "./state";
import type { TypeChecks } from "./type-checks";

/** シェル（画面）側の受け口。内容は拡張機能が決めるが、描くのはホスト（FR-031・FR-032）。 */
export interface ShellPort {
  notify(level: "info" | "warn" | "error", text: string, source: string): void;
  confirm(prompt: {
    extId: string;
    message: string;
    okLabel: string | undefined;
    cancelLabel: string | undefined;
  }): Promise<boolean>;
  setStatusBarItem(
    item: {
      source: string;
      id: string;
      alignment: "left" | "right";
      priority: number;
      text: string;
      tooltip?: string;
      command?: string;
    } | null,
    key: { source: string; id: string },
  ): void;
  showView(viewId: string): void;
  setContext(
    extId: string,
    key: string,
    value: string | number | boolean | null,
  ): void;
  /** コマンドの処理を結ぶ（宣言は、マニフェストの contributes の反映が行う）。 */
  provideCommand(
    commandId: string,
    run: (args: unknown) => Promise<unknown>,
  ): { dispose(): void };
  executeCommand(
    id: string,
    args: unknown,
  ): Promise<{ ok: true; value?: unknown } | { ok: false; reason: string }>;
}

export interface HostApiDeps {
  ipc: HostIpc;
  gate: PermissionGate;
  state: HostState;
  /** 言語（`ja` / `en`）。ラベルの表示名などに使う。 */
  locale(): string;
  /** マニフェストの宣言（種別・アイテム提供の名前など）。 */
  manifests: ManifestIndex;
  /** 拡張機能ごとの登録（止めたとき、まとめて取り消す）。 */
  registrations(): Registrations;
  /** 種別などの実装が登録したメンバー（`register` の `members`）。 */
  members: Map<string, readonly string[]>;
  shell: ShellPort;
  /** 拡張機能の裏の枠の関数を呼ぶ（コマンドの実行など）。 */
  callFrame(extId: string, m: string, a: unknown): Promise<unknown>;
  /** 種別の `validate` / `summarize`（定義側の枠へ問い合わせる）。無ければ検査しない。 */
  typeChecks?: TypeChecks;
  /** 選択（FR-024）。無ければ何もしない。 */
  selection?: { set(ids: string[]): Promise<void> };
  /** 候補（FR-025〜027）。無ければ `annotations.suggest` は使えない。 */
  suggestions?: SuggestionStore;
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
