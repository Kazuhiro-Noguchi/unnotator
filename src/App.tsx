import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, onMount } from "solid-js";
import { extensionHost, startExtensionHost } from "./host/instance";
import { detectLanguage, format, t } from "./i18n";
import { commands, events } from "./ipc";
import { openDirectoryDialog } from "./ipc/dialog";
import { appearance } from "./shell/appearance";
import { declareCoreCommands } from "./shell/commands/core-commands";
import { provideCoreHandlers } from "./shell/commands/core-handlers";
import { EditorSurface } from "./shell/explorer/EditorSurface";
import {
  explorer,
  itemSource,
  provideExplorerCommands,
} from "./shell/explorer/instance";
import { projectPort, settingsPort } from "./shell/ipc-port";
import { defaultKeybindings } from "./shell/keys/defaults";
import { installKeyDispatcher } from "./shell/keys/dispatch";
import { isEditableTarget } from "./shell/keys/editable";
import { provideLabelCommands } from "./shell/labels/instance";
import { registerCoreViews } from "./shell/layout/core-views";
import {
  bindProjectContext,
  projectName,
  titleText,
} from "./shell/layout/project-context";
import { Shell } from "./shell/layout/Shell";
import { normalizeLayout } from "./shell/layout/state";
import { provideModeCommands } from "./shell/mode/instance";
import { NotificationCenter } from "./shell/notify/NotificationCenter";
import { Toasts } from "./shell/notify/Toasts";
import { Overlays } from "./shell/overlays/Overlays";
import { reportProblem } from "./shell/problems";
import { projectData } from "./shell/project-data/instance";
import { provideEditCommands } from "./shell/properties/instance";
import { Ribbon } from "./shell/ribbon/Ribbon";
import { provideSchemaCommands } from "./shell/schema/instance";
import {
  commands as commandRegistry,
  ctx,
  keymap,
  layout,
  notify,
  projectNameSignal,
  quickAccess,
  recentProjects,
  saveUiSetting,
  setLayoutSaver,
  setProjectName,
  setRecentProjects,
  setSettingSaver,
  setUserKeybindings,
  statusStore,
  views,
} from "./shell/services";
import {
  createNativeFolderPicker,
  createProjectActions,
} from "./shell/settings/folder-picker";
import {
  createUiSettingsWriter,
  loadUiSettings,
} from "./shell/settings/ui-settings";
import { createWindowCloseHandler } from "./shell/settings/window-close";
import { fromContext } from "./shell/solid";
import { startup } from "./shell/startup";
import { StatusBar } from "./shell/status/StatusBar";
import {
  askCloseDecision,
  dialogFolderPicker,
  setAboutOpen,
  setPaletteOpen,
  setSettingsOpen,
} from "./shell/ui-state";

// ---- 組み立て（モジュールの読み込み時に 1 回） ----
// OS 標準のダイアログ。開けないとき（ブラウザでの開発）だけ、パス入力の簡易ダイアログに切り替える
const nativeFolderPicker = createNativeFolderPicker(
  openDirectoryDialog,
  dialogFolderPicker,
);

const projectContext = bindProjectContext({ ctx, ...projectPort });

const actions = createProjectActions({
  pick: (purpose) =>
    nativeFolderPicker.pick({
      title: t(purpose === "new" ? "folder.title.new" : "folder.title.open"),
    }),
  open: async (folder, create) => {
    const result = await commands.projectOpen(folder, create);
    void extensionHost.startup().catch(() => {});
    return { kind: result.kind };
  },
  restore: async () => {
    await commands.recoveryRestore();
  },
  ask: askCloseDecision,
  close: async (action) => {
    await commands.projectClose(action);
    await extensionHost.shutdown();
    setProjectName(null);
    await explorer.close();
    projectData.reset();
    await projectContext.setOpen(false);
  },
  save: async () => {
    await commands.projectSave();
  },
  undo: async () => {
    await commands.undo();
  },
  redo: async () => {
    await commands.redo();
  },
  getRecents: recentProjects,
  setRecents: (list) => {
    setRecentProjects(list);
    saveUiSetting("ui.recentProjects", list);
  },
  isOpen: () => ctx.get("projectOpen") === true,
  isDirty: () => ctx.get("projectDirty") === true,
  onOpened: async (folder) => {
    setProjectName(projectName(folder));
    await projectContext.setOpen(true);
    await explorer.open(folder);
    await projectData.refresh();
  },
  notify,
});

declareCoreCommands(commandRegistry);
keymap.setLayer("core", "core", defaultKeybindings());
provideCoreHandlers({
  commands: commandRegistry,
  actions,
  layout: {
    toggle: (region) => layout.toggle(region),
    showPrimarySidebarView: (view) => {
      const { primarySidebar } = layout.get();
      if (!(primarySidebar.visible && primarySidebar.view === view)) {
        layout.selectPrimarySidebarView(view);
      }
    },
  },
  appearance,
  openPalette: () => setPaletteOpen(true),
  openSettings: () => setSettingsOpen(true),
  openAbout: () => setAboutOpen(true),
});
provideExplorerCommands(commandRegistry, notify);
provideLabelCommands(commandRegistry, notify);
provideModeCommands(commandRegistry);
provideEditCommands(commandRegistry, notify);
provideSchemaCommands(commandRegistry);
// 設定を読む前は、OS の設定に合わせて描く。
appearance.applyTheme("system");
appearance.applyLanguage("system");
// 開発ビルドだけ: 画面の部品を押して確かめられるよう、仮の処理（デモ）を結ぶ。
// 開発ビルド、または `VITE_UNNO_DEV_TOOLS=1` を付けてビルドしたときだけ（実機での確認・計測用）。
if (import.meta.env.DEV || import.meta.env.VITE_UNNO_DEV_TOOLS === "1") {
  void import("./shell/dev/demo-commands").then((demo) =>
    import("./shell/dev/item-demo").then((itemDemo) =>
      demo.installDemoCommands({
        commands: commandRegistry,
        ctx,
        notify,
        enableItemDemo: () => itemDemo.enableItemDemo(itemSource),
        measureExplorer: () =>
          import("./shell/dev/measure-explorer").then((m) => m.measureAll()),
        spikeS02: () =>
          import("./shell/dev/spike-s02").then((m) => m.runSpikeS02()),
        measureProperties: () =>
          import("./shell/dev/measure-properties").then((m) =>
            m.measureProperties(),
          ),
      }),
    ),
  );
}
if (import.meta.env.DEV && import.meta.env.VITE_S02_AUTORUN) {
  setTimeout(
    () => void import("./shell/dev/spike-s02").then((m) => m.runSpikeS02()),
    3000,
  );
}
registerCoreViews(views, {
  createNew: () => void commandRegistry.execute("core.project.new"),
  openFolder: () => void commandRegistry.execute("core.project.open"),
});

// 新規ファイルの確認（走査）の進み具合を、ステータスバーのメッセージに出す。
// 終わったら完了を知らせ、少し待ってから消す。
const SCAN_DONE_VISIBLE_MS = 4000;
let scanDoneTimer: ReturnType<typeof setTimeout> | undefined;
void events.scanProgressEvent
  .listen((event) => {
    const { found, phase } = event.payload;
    clearTimeout(scanDoneTimer);
    if (phase === "done") {
      statusStore.setMessage(t("status.scanDone"));
      scanDoneTimer = setTimeout(
        () => statusStore.setMessage(null),
        SCAN_DONE_VISIBLE_MS,
      );
      return;
    }
    statusStore.setMessage(
      phase === "walking"
        ? format(t("status.scanning"), { found })
        : t("status.applying"),
    );
  })
  .catch(() => {});

async function applySettings(): Promise<void> {
  const settings = await loadUiSettings(settingsPort, reportProblem);
  const writer = createUiSettingsWriter(settingsPort, reportProblem, notify);
  setSettingSaver((key, value) => writer.save(key, value));
  setLayoutSaver((next) => writer.save("ui.layout", next));
  layout.replace(
    normalizeLayout(settings.layout, {
      width: window.innerWidth,
      height: window.innerHeight,
    }),
  );
  quickAccess.setAll(settings.quickAccess);
  appearance.applyTheme(settings.theme);
  appearance.applyLanguage(settings.language);
  setUserKeybindings(settings.keybindings);
  keymap.setLayer("user", "user", settings.keybindings);
  setRecentProjects(settings.recentProjects);
}

// ウィンドウを閉じるとき。未保存なら確認し、正常に閉じて作業用データ（自動復元の元）を消す。
const handleWindowClose = createWindowCloseHandler({
  isOpen: () => ctx.get("projectOpen") === true,
  isDirty: () => ctx.get("projectDirty") === true,
  ask: askCloseDecision,
  closeProject: async (action) => {
    await commands.projectClose(action);
    await extensionHost.shutdown();
  },
  destroyWindow: () => getCurrentWindow().destroy(),
  notify,
});

export function App() {
  const dirty = fromContext(ctx, () => ctx.get("projectDirty") === true);
  createEffect(() => {
    const title = titleText(projectNameSignal(), dirty());
    try {
      void getCurrentWindow()
        .setTitle(title)
        .catch(() => {});
    } catch {
      // Tauri の外（ブラウザでの確認）では、ウィンドウが無い。
    }
  });
  onMount(() => {
    try {
      void getCurrentWindow()
        .onCloseRequested((event) => {
          event.preventDefault();
          void handleWindowClose();
        })
        .catch((error: unknown) => {
          // 登録に失敗すると、閉じるときの確認が出ない。黙らせずに知らせる。
          notify("error", `window close handler: ${String(error)}`);
        });
    } catch {
      // Tauri の外（ブラウザでの確認）では、ウィンドウが無い。
    }
    installKeyDispatcher(window, {
      keymap,
      commands: commandRegistry,
      isEditable: isEditableTarget,
    });
    void startup({
      setTitle: (title) => getCurrentWindow().setTitle(title),
      appInfo: () => commands.appInfo(),
      reportReady: () => commands.reportReady(),
      t: (key) => t(key, detectLanguage()),
      // onMount は最初の描画の後に呼ばれる。さらに 1 フレーム待って画面に出たあとで知らせる。
      onFirstRender: (callback) => {
        requestAnimationFrame(() => callback());
      },
      applySettings,
    });
    startExtensionHost();
  });
  return (
    <>
      <Shell
        ribbon={<Ribbon />}
        statusBar={<StatusBar />}
        editor={<EditorSurface />}
      />
      <Toasts />
      <NotificationCenter />
      <Overlays />
    </>
  );
}
