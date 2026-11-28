// Host API の本体（アプリで 1 つ）。権限の門・各部の実装・本体の状態の写しを束ねる。
// `instance.ts` が、拡張機能ホスト（`createExtensionHost`）の `handle` などに結ぶ。
import { Registrations } from "../activation";
import { createApiBroker } from "../api-proxy";
import type { HostRequest } from "../channel";
import type { Frame } from "../frames";
import { createHostApi, type HostApi } from "./api";
import type { Handlers, ShellPort } from "./api-types";
import { type ChangeBridge, createChangeBridge } from "./events";
import type { HostIpc } from "./ipc";
import type { ManifestIndex } from "./manifests";
import { createMirrorFeed } from "./mirror-feed";
import {
  type ConsentPrompt,
  createPermissionGate,
  type PermissionGate,
} from "./permissions";
import { createHostState, type HostState, MIRROR_KEYS } from "./state";
import { createTypeChecks } from "./type-checks";

export interface HostAppDeps {
  ipc: HostIpc;
  manifests: ManifestIndex;
  locale(): string;
  /** ダイアログに出す名前。 */
  nameOf(extId: string): string;
  /** ホストが描く権限のダイアログ。 */
  ask(prompt: ConsentPrompt & { name: string }): Promise<boolean>;
  /** 設定の現在の値（有効な値。無ければ `undefined`）。 */
  readSetting(key: string): Promise<unknown>;
  /** 種別を定義した拡張機能の裏の枠（必要なら有効化する）。得られなければ `undefined`。 */
  background?(
    extId: string,
  ): Promise<{ call(m: string, a: unknown): Promise<unknown> } | undefined>;
  /** 拡張機能ごとの登録（止めたとき、まとめて取り消す）。`ActivationManager` のものを渡す。 */
  registrations?: () => Registrations;
  /** シェル（画面）側の受け口。無ければ何もしない（テスト用）。 */
  shell?: ShellPort;
  /** 各部の実装（write・events・misc など）。 */
  handlers?: (app: HostApp) => Handlers[];
}

export interface HostApp {
  readonly state: HostState;
  /** 変更の通知（シェルの購読者と枠の両方へ）。 */
  readonly changes: ChangeBridge;
  readonly gate: PermissionGate;
  readonly api: HostApi;
  readonly deps: HostAppDeps;
  handle(request: HostRequest): Promise<unknown>;
  mirrorInit(extId: string): Promise<Record<string, unknown>>;
  onFrameCreate(frame: Frame): void;
  onFrameRemove(frame: Frame): void;
  onLog(extId: string, value: unknown): void;
  /** 宣言された設定のキーを読み直して、写しに反映する。 */
  refreshSettings(): Promise<void>;
}

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
/** `host.log` 1 件の文字数の上限。 */
export const MAX_LOG_CHARS = 2000;

const IDLE_SHELL: ShellPort = {
  notify: () => {},
  confirm: async () => false,
  setStatusBarItem: () => {},
  showView: () => {},
  setContext: () => {},
  provideCommand: () => ({ dispose() {} }),
  executeCommand: async () => ({ ok: false, reason: "unknown" }),
};

export function createHostApp(deps: HostAppDeps): HostApp {
  const state = createHostState();
  const gate = createPermissionGate({
    checkPermission: (extId, permission) =>
      deps.ipc.checkPermission(extId, permission),
    consent: (extId, permissions) => deps.ipc.consent(extId, permissions),
    ask: (prompt) => deps.ask({ ...prompt, name: deps.nameOf(prompt.extId) }),
  });
  const allowed = async (extId: string, permission: string) => {
    try {
      return (
        (await deps.ipc.checkPermission(extId, permission)).verdict ===
        "allowed"
      );
    } catch {
      return false;
    }
  };
  const feed = createMirrorFeed({
    state,
    allowed,
    declaredSettings: (extId) => deps.manifests.get(extId)?.settingKeys ?? [],
  });

  const changes = createChangeBridge({ allowed });

  /** 種別の実装が登録したメンバー（`register` の `members`）。`validate` があるかを知る。 */
  const members = new Map<string, readonly string[]>();
  const fallbackRegistrations = new Registrations();
  const registrations = () => deps.registrations?.() ?? fallbackRegistrations;
  const typeChecks = createTypeChecks({
    manifests: deps.manifests,
    background: async (extId) => deps.background?.(extId),
    members: (extId, localId) => members.get(`${extId}\u0000${localId}`) ?? [],
    asset: (assetId) => deps.ipc.internalAsset(assetId),
    locale: deps.locale,
  });

  // 枠ごとの購読の解除。同じ枠から 2 度は結ばない。
  const detaches = new Map<Frame, () => void>();

  const app: HostApp = {
    state,
    changes,
    gate,
    deps,
    // 下で作る。
    api: undefined as unknown as HostApi,
    handle: (request) => app.api.handle(request),
    mirrorInit: (extId) => feed.snapshot(extId),
    onFrameCreate(frame) {
      if (detaches.has(frame)) return;
      const emit = (key: string, value: unknown) =>
        frame.channel.emit(key, value);
      const offMirror = feed.attach(frame.extensionId, emit);
      const offChanges = changes.attach(frame.extensionId, emit);
      detaches.set(frame, () => {
        offMirror();
        offChanges();
      });
      // `init` に入れた値との行き違い（作る前の変化）を補う。
      void feed.snapshot(frame.extensionId).then((all) => {
        if (!detaches.has(frame)) return;
        for (const key of MIRROR_KEYS) emit(key, all[key]);
      });
    },
    onFrameRemove(frame) {
      detaches.get(frame)?.();
      detaches.delete(frame);
      // 裏の枠が無くなる（拡張機能が止まる）とき、開きっぱなしの transaction を捨てる。
      if (frame.role === "background")
        app.api.closeExtension(frame.extensionId);
    },
    onLog(extId, value) {
      const record =
        typeof value === "object" && value !== null
          ? (value as { level?: unknown; args?: unknown })
          : {};
      const level =
        typeof record.level === "string" && LOG_LEVELS.has(record.level)
          ? record.level
          : "info";
      const args = Array.isArray(record.args) ? record.args : [];
      const text = args
        .map((a) => String(a))
        .join(" ")
        .slice(0, MAX_LOG_CHARS);
      // ログの失敗は、拡張機能にも本体にも影響させない。
      void deps.ipc.log(extId, level, text).catch(() => {});
    },
    async refreshSettings() {
      const keys = new Set(deps.manifests.all().flatMap((m) => m.settingKeys));
      const values: Record<string, unknown> = {};
      await Promise.all(
        [...keys].map(async (key) => {
          try {
            const value = await deps.readSetting(key);
            if (value !== undefined) values[key] = value;
          } catch {
            // 読めない設定は、値なしとして扱う。
          }
        }),
      );
      state.set("settings", values);
    },
  };
  const apiBroker = createApiBroker({
    manifests: deps.manifests,
    background: async (extId) => deps.background?.(extId),
  });
  const hostApi = createHostApi(
    {
      ipc: deps.ipc,
      gate,
      state,
      locale: deps.locale,
      manifests: deps.manifests,
      registrations,
      members,
      shell: deps.shell ?? IDLE_SHELL,
      callFrame: async (extId, m, a) => {
        const frame = await deps.background?.(extId);
        if (frame === undefined)
          throw new Error(`extension is not running: ${extId}`);
        return frame.call(m, a);
      },
      typeChecks,
      onApplied: (set, name) => changes.noteLabel(set.seq, name),
    },
    [apiBroker.handlers, ...(deps.handlers?.(app) ?? [])],
  );
  (app as { api: HostApi }).api = {
    handle: (request) => hostApi.handle(request),
    closeExtension: (extId) => {
      hostApi.closeExtension(extId);
      apiBroker.forget(extId);
    },
  };
  return app;
}
