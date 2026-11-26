// 画面の論理が使う小さな出入口（port）を、実際の IPC（src/ipc/）につなぐ。
import { commands, events } from "../ipc";
import type { SettingsPort } from "./settings/ui-settings";

/** 利用者の設定（user 層）の読み書き。`ui.*` は user 層だけを使う。 */
export const settingsPort: SettingsPort = {
  async readUserLayer() {
    const text = await commands.settingsLayer("user");
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  },
  async write(key, value) {
    await commands.settingsSet("user", key, JSON.stringify(value));
  },
};

export const projectPort = {
  undoState: () => commands.undoState(),
  saveState: () => commands.saveState(),
  onStateChanged: (handler: (state: { dirty: boolean }) => void) => {
    const off = events.projectStateChanged.listen((event) =>
      handler(event.payload),
    );
    return () => void off.then((fn) => fn());
  },
  onProjectChanged: (handler: () => void) => {
    const off = events.projectChanged
      .listen(() => handler())
      .catch(() => () => {});
    return () => void off.then((fn) => fn());
  },
};
