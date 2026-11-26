// 開発用のデモのコマンド（通知・プロジェクトの状態の切り替え）。パレットから実行して、画面の部品を確かめる。
// 開発ビルド（`pnpm tauri dev`）だけで読み込み、製品のビルドには含めない（App.tsx の `import.meta.env.DEV`）。
// 未提供のコマンドに、仮の処理は結ばない（本物の処理は 007・008・009 が `commands.provide` で結ぶ）。
import { t } from "../../i18n";
import type { CommandRegistry } from "../commands/registry";
import type { Context, Disposable, NotifyLevel, NotifyOptions } from "../types";

export interface DemoDeps {
  commands: CommandRegistry;
  ctx: Context;
  notify: (level: NotifyLevel, text: string, options?: NotifyOptions) => void;
  /** アイテムのデモを有効にする（`.pages` のファイルを、アイテムのある媒体にする）。 */
  enableItemDemo?: () => Promise<void>;
}

export function installDemoCommands({
  commands,
  ctx,
  notify,
  enableItemDemo,
}: DemoDeps): Disposable {
  // プロジェクトの状態を切り替えるデモのコマンド（パレットから実行する）。
  const declare = (
    id: string,
    ja: string,
    en: string,
    run: () => void,
    icon?: string,
  ) => {
    commands.declare({
      id,
      title: { ja, en },
      ...(icon === undefined ? {} : { icon }),
      category: { ja: "デモ", en: "Demo" },
      source: "dev",
      run,
    });
  };
  if (enableItemDemo) {
    declare(
      "dev.demo.items",
      "アイテムのデモを有効にする（.pages）",
      "Enable item demo (.pages)",
      () => void enableItemDemo().catch(() => {}),
    );
  }
  declare(
    "dev.demo.toggleProject",
    "プロジェクトの開閉",
    "Toggle project",
    () => {
      const open = ctx.get("projectOpen") !== true;
      ctx.set("projectOpen", open);
      if (!open) {
        ctx.set("canUndo", false);
        ctx.set("canRedo", false);
        ctx.set("projectDirty", false);
      }
    },
  );
  declare("dev.demo.toggleUndo", "未保存の切替", "Toggle unsaved", () => {
    const on = ctx.get("canUndo") !== true;
    ctx.set("canUndo", on);
    ctx.set("canRedo", on);
    ctx.set("projectDirty", on);
  });

  declare(
    "dev.demo.toastInfo",
    "情報の通知",
    "Info notification",
    () => notify("info", t("dev.demoInfoText"), { source: "Demo" }),
    "$(info)",
  );
  declare(
    "dev.demo.toastWarn",
    "警告の通知",
    "Warning notification",
    () => notify("warn", t("dev.demoWarnText"), { source: "Demo" }),
    "$(problems)",
  );
  declare(
    "dev.demo.toastError",
    "エラーの通知",
    "Error notification",
    () => notify("error", t("dev.demoErrorText"), { source: "Demo" }),
    "$(close)",
  );
  declare(
    "dev.demo.longToast",
    "長い通知",
    "Long notification",
    () =>
      notify("warn", t("dev.demoLongText"), {
        source: "Demo",
        actions: [{ label: t("dev.demoYes"), primary: true, run: () => {} }],
      }),
    "$(problems)",
  );
  declare(
    "dev.demo.actionToast",
    "操作つきの通知",
    "Notification with actions",
    () => {
      notify("info", t("dev.demoActionText"), {
        source: "Demo",
        settings: () => notify("info", t("dev.demoSettings")),
        actions: [
          {
            label: t("dev.demoYes"),
            primary: true,
            run: () => notify("info", t("dev.demoYes")),
          },
          {
            label: t("dev.demoAlways"),
            run: () => notify("info", t("dev.demoAlways")),
          },
          {
            label: t("dev.demoNever"),
            run: () => notify("info", t("dev.demoNever")),
          },
        ],
      });
    },
    "$(bell)",
  );

  return {
    dispose() {
      commands.unregister("dev");
    },
  };
}
