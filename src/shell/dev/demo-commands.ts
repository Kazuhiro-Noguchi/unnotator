// 開発用のデモのコマンド。画面の部品（リボン・トグル・メニュー）を、実機で押して確かめるための仮の処理。
// 開発ビルド（`pnpm tauri dev`）だけで読み込み、製品のビルドには含めない（App.tsx の `import.meta.env.DEV`）。
// 本物の処理（007・008・009 が `commands.provide` で結ぶ）がすでにあるコマンドには、触らない。
import { format, t } from "../../i18n";
import type { CommandRegistry } from "../commands/registry";
import { resolveTitle } from "../title";
import type { Context, Disposable, NotifyLevel, NotifyOptions } from "../types";

/** トグルのコマンド → オン・オフを持つコンテキストのキー（リボンの `checked` が読む）。 */
export const DEMO_TOGGLES: Record<string, string> = {
  "core.tool.select": "toolSelectActive",
  "core.view.annotations.toggle": "annotationsVisible",
  "core.view.labelNames.toggle": "labelNamesVisible",
};

export interface DemoDeps {
  commands: CommandRegistry;
  ctx: Context;
  notify: (level: NotifyLevel, text: string, options?: NotifyOptions) => void;
}

const flip = (ctx: Context, key: string): boolean => {
  const next = ctx.get(key) !== true;
  ctx.set(key, next ? true : null);
  return next;
};

export function installDemoCommands({
  commands,
  ctx,
  notify,
}: DemoDeps): Disposable {
  const handles: Disposable[] = [];

  // 未提供のコアのコマンドに、仮の処理を結ぶ。
  for (const spec of commands.list()) {
    if (spec.source !== "core") continue;
    if (commands.availability(spec.id)().enabled) continue;
    const key = DEMO_TOGGLES[spec.id];
    handles.push(
      commands.provide(spec.id, () => {
        if (key) flip(ctx, key);
        notify(
          "info",
          format(t("dev.demoRan"), { title: resolveTitle(spec.title, "ja") }),
          { source: "Demo" },
        );
      }),
    );
  }

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
      for (const handle of handles) handle.dispose();
      commands.unregister("dev");
    },
  };
}
