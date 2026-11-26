// シェルの部品が共有する、アプリに 1 つの登録簿・ストア。
import { createSignal } from "solid-js";
import { createCommandRegistry } from "./commands/registry";
import { detectPlatform } from "./keys/chord";
import { createKeymap } from "./keys/keymap";
import { createLayoutStore, defaultLayout } from "./layout/state";
import { createViewRegistry } from "./layout/views";
import { createNotifyStore } from "./notify/store";
import { reportProblem } from "./problems";
import { coreRibbon } from "./ribbon/core-ribbon";
import { createRibbonModel } from "./ribbon/model";
import { createQuickAccess } from "./ribbon/quick-access";
import { DEFAULT_QUICK_ACCESS } from "./settings/ui-settings";
import { createStatusStore } from "./status/store";
import type { LayoutState, NotifyLevel } from "./types";
import { shellContext } from "./when/context";

export const notifyStore = createNotifyStore();
export const statusStore = createStatusStore();
export const notify = (level: NotifyLevel, text: string): void => {
  notifyStore.notify(level, text);
};

/** 配置の保存の出口。起動時に、設定の書き込みへ差し替える。 */
let saveLayout: (layout: LayoutState) => void = () => {};
export function setLayoutSaver(saver: (layout: LayoutState) => void): void {
  saveLayout = saver;
}

export const ctx = shellContext;
export const commands = createCommandRegistry({
  ctx,
  report: reportProblem,
  notify,
});
export const views = createViewRegistry(ctx, reportProblem);
export const layout = createLayoutStore({
  initial: defaultLayout(),
  ctx,
  save: (next) => saveLayout(next),
});

/** 設定の保存の出口（`ui.*`）。起動時に、設定の書き込みへ差し替える。 */
let settingSaver: (key: string, value: unknown) => void = () => {};
export function setSettingSaver(
  saver: (key: string, value: unknown) => void,
): void {
  settingSaver = saver;
}
export const saveUiSetting = (key: string, value: unknown): void =>
  settingSaver(key, value);

export const platform = detectPlatform();
export const keymap = createKeymap({ ctx, report: reportProblem, platform });

/** 利用者の設定の写し（起動時に読み込む）。 */
export const [userKeybindings, setUserKeybindings] = createSignal<unknown[]>(
  [],
);
export const [recentProjects, setRecentProjects] = createSignal<string[]>([]);

/** 開いているプロジェクトの名前（無ければ null）と、未保存かどうか。 */
export const [projectNameSignal, setProjectName] = createSignal<string | null>(
  null,
);

export const ribbon = createRibbonModel({
  core: coreRibbon(),
  ctx,
  commands,
  report: reportProblem,
});

export const quickAccess = createQuickAccess({
  initial: [...DEFAULT_QUICK_ACCESS],
  commands,
  save: (ids) => saveUiSetting("ui.quickAccess", ids),
});
