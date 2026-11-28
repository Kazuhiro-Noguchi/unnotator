// アプリで使う拡張機能ホスト（1 つだけ）。実際の IPC・通知・問題ビューにつなぐ。
import { detectLanguage } from "../i18n";
import { commands, events } from "../ipc";
import { explorer } from "../shell/explorer/instance";
import { activeLabel } from "../shell/labels/instance";
import { askConsent } from "../shell/overlays/consent";
import { reportProblem } from "../shell/problems";
import { notify } from "../shell/services";
import { createHostApp } from "./host-api/host-app";
import { realHostIpc } from "./host-api/ipc";
import { createManifestIndex } from "./host-api/manifests";
import { toLabel } from "./host-api/mappers";
import { createExtensionHost, type ExtensionInfo } from "./service";

function base(): string {
  // Windows の WebView2 は `http://unno.localhost/...`、それ以外は `unno://localhost/...`（Tauri の規則）。
  return navigator.userAgent.includes("Windows")
    ? "http://unno.localhost"
    : "unno://localhost";
}

async function list(): Promise<ExtensionInfo[]> {
  const entries = await commands.extensionList(null);
  return await Promise.all(
    entries.map(async (entry) => {
      if (entry.status !== "enabled") {
        return {
          id: entry.id,
          version: entry.version,
          status: entry.status,
          manifest: null,
        };
      }
      const detail = await commands.extensionGet(entry.id, null);
      return {
        id: entry.id,
        version: entry.version,
        status: entry.status,
        manifest: detail.manifest ?? null,
      };
    }),
  );
}

function createContainer(): HTMLElement {
  const el = document.createElement("div");
  // 裏の枠は画面に出さない。
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;";
  document.body.append(el);
  return el;
}

/** 登録簿の表示名（権限のダイアログに出す）。 */
function displayName(extId: string): string {
  const raw = extensionHost.infos().find((info) => info.id === extId)?.manifest;
  try {
    const name = raw === null || raw === undefined ? null : JSON.parse(raw);
    if (typeof name?.displayName === "string") return name.displayName;
  } catch {
    // 読めなければ ID を出す。
  }
  return extId;
}

const manifests = createManifestIndex(() => extensionHost.infos());

/** Host API の本体（権限の門・読み書き・写し）。 */
export const hostApp = createHostApp({
  ipc: realHostIpc,
  manifests,
  locale: () => detectLanguage(),
  nameOf: displayName,
  ask: (prompt) => askConsent(prompt),
  readSetting: async (key) => {
    const setting = await commands.settingsGet(key);
    return JSON.parse(setting.value_json) as unknown;
  },
});

export const extensionHost = createExtensionHost({
  list,
  doc: document,
  container: createContainer(),
  base: base(),
  locale: () => detectLanguage(),
  handle: (request) => hostApp.handle(request),
  mirrorInit: (id) => hostApp.mirrorInit(id),
  onFrameCreate: (frame) => hostApp.onFrameCreate(frame),
  onFrameRemove: (frame) => hostApp.onFrameRemove(frame),
  onLog: (id, value) => hostApp.onLog(id, value),
  report: (level, text, extensionId) => {
    reportProblem({
      code: "extension.failure",
      source: extensionId,
      message: text,
    });
    notify(level, `${extensionId}: ${text}`, { source: extensionId });
  },
});

/** 本体の状態（有効なラベル・開いている対象）を、写しの元に結ぶ。 */
function bindState(): void {
  const syncLabel = () => {
    const row = activeLabel.get();
    hostApp.state.set(
      "labels.active",
      row === null ? null : toLabel(row, detectLanguage()),
    );
  };
  activeLabel.subscribe(syncLabel);
  syncLabel();
  const syncCurrent = () => {
    const current = explorer.current.get();
    hostApp.state.set(
      "assets.current",
      current === null
        ? null
        : current.itemKey === null
          ? { assetId: current.assetId }
          : { assetId: current.assetId, itemKey: current.itemKey },
    );
  };
  explorer.current.subscribe(syncCurrent);
  syncCurrent();
  extensionHost.onDidRefresh(() => void hostApp.refreshSettings());
  void events.settingsChangedEvent
    .listen(() => void hostApp.refreshSettings())
    .catch(() => {});
  void events.permissionsChanged
    .listen((event) => hostApp.gate.forget(event.payload.id))
    .catch(() => {});
}

/** 起動時に 1 回。登録簿の変更（導入・削除・有効 / 無効）でも読み直す。 */
export function startExtensionHost(): void {
  bindState();
  void extensionHost.startup().catch(() => {});
  void events.extensionsChanged
    .listen(() => void extensionHost.refresh().catch(() => {}))
    .catch(() => {});
}
