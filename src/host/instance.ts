// アプリで使う拡張機能ホスト（1 つだけ）。実際の IPC・通知・問題ビューにつなぐ。
import { createComponent } from "solid-js";
import { detectLanguage } from "../i18n";
import { commands, events } from "../ipc";
import { explorer } from "../shell/explorer/instance";
import { activeLabel } from "../shell/labels/instance";
import { MetricsView } from "../shell/layout/MetricsView";
import { showExtensionView } from "../shell/layout/surfaces-instance";
import { askConfirm } from "../shell/overlays/confirm";
import { askConsent } from "../shell/overlays/consent";
import { reportExtensionProblem, reportProblem } from "../shell/problems";
import { projectData, selection } from "../shell/properties/instance";
import { loadAllPages } from "../shell/properties/paging";
import {
  ctx,
  keymap,
  notify,
  ribbon,
  commands as shellCommands,
  statusStore,
  views,
} from "../shell/services";
import { createContributesSync } from "./contributes";
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

/** 現在位置のアノテーションの ID。変更・現在位置の移動で作り直す（`selection.set` のたびに読み直さない）。 */
let knownIds: Promise<ReadonlySet<string>> | null = null;
function invalidateKnownIds(): void {
  knownIds = null;
}
function currentIds(): Promise<ReadonlySet<string>> {
  knownIds ??= loadAllPages(
    (cursor) => projectData.annotationsPage(cursor),
    () => true,
  )
    .then(
      (rows) =>
        new Set((rows ?? []).map((row) => row.id)) as ReadonlySet<string>,
    )
    .catch(() => {
      knownIds = null;
      return new Set<string>();
    });
  return knownIds;
}
projectData.subscribe(invalidateKnownIds);
explorer.current.subscribe(invalidateKnownIds);

const manifests = createManifestIndex(() => extensionHost.infos());

/** Host API の本体（権限の門・読み書き・写し）。 */
export const hostApp = createHostApp({
  ipc: realHostIpc,
  manifests,
  locale: () => detectLanguage(),
  nameOf: displayName,
  ask: (prompt) => askConsent(prompt),
  registrations: () => extensionHost.manager.registrations,
  selection: {
    port: selection,
    exists: async (ids) => {
      let known = await currentIds();
      // 作った直後の ID は、変更の通知より先に来ることがある。見つからないときだけ、読み直して確かめる。
      if (ids.some((id) => !known.has(id))) {
        invalidateKnownIds();
        known = await currentIds();
      }
      return new Set(ids.filter((id) => known.has(id)));
    },
  },
  shell: {
    notify: (level, text, source) => notify(level, text, { source }),
    confirm: (prompt) =>
      askConfirm({ ...prompt, name: displayName(prompt.extId) }),
    setStatusBarItem: (item, key) => statusStore.setItem(item, key),
    showView: (id) => void showExtensionView(id),
    setContext: (extId, key, value) => ctx.setNamespaced(extId, key, value),
    provideCommand: (id, run) => shellCommands.provide(id, run),
    executeCommand: async (id, args) => {
      const result = await shellCommands.execute(id, args);
      return result.ok
        ? { ok: true, value: result.value }
        : { ok: false, reason: result.reason };
    },
  },
  background: async (id) => {
    try {
      await extensionHost.manager.activate(id);
    } catch {
      return undefined;
    }
    return extensionHost.frames.background(id)?.channel;
  },
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
  // 記録（ログ・失敗・拒否・警告）は `record` が問題ビューへ入れる。ここは通知だけ。
  record: reportExtensionProblem(reportProblem),
  report: (level, text, extensionId) => {
    notify(level, `${extensionId}: ${text}`, { source: extensionId });
  },
});

/** マニフェストの contributes を、シェルの登録簿へ反映する（有効化の前から。FR-011）。 */
const contributesSync = createContributesSync({
  targets: {
    ctx,
    commands: shellCommands,
    keymap,
    ribbon,
    status: statusStore,
  },
  host: {
    infos: () => extensionHost.infos(),
    onDidRefresh: (listener) => extensionHost.onDidRefresh(listener),
    trigger: (event) => extensionHost.trigger(event),
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
  void events.projectChanged
    .listen((event) => hostApp.changes.publish(event.payload))
    .catch(() => {});
  void events.permissionsChanged
    .listen((event) => hostApp.gate.forget(event.payload.id))
    .catch(() => {});
}

/** 起動時に 1 回。登録簿の変更（導入・削除・有効 / 無効）でも読み直す。 */
/** 開発者モードのときだけ、拡張機能の計測を「問題」の隣のパネルに出す（FR-023）。 */
async function refreshDevMode(): Promise<void> {
  try {
    const devMode = await commands.devmodeGet();
    ctx.set("devMode", devMode.enabled);
  } catch {
    ctx.set("devMode", false);
  }
}

export function startExtensionHost(): void {
  bindState();
  views.register({
    id: "extension-metrics",
    title: { key: "view.metrics.title" },
    icon: "$(output)",
    location: "panel",
    when: "devMode",
    source: "core",
    render: () =>
      createComponent(MetricsView, { metrics: extensionHost.metrics }),
  });
  void refreshDevMode();
  contributesSync.start();
  void extensionHost.startup().catch(() => {});
  void events.extensionsChanged
    .listen(() => {
      void refreshDevMode();
      void extensionHost.refresh().catch(() => {});
    })
    .catch(() => {});
}
