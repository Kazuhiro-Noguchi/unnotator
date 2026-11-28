// アプリで使う拡張機能ホスト（1 つだけ）。実際の IPC・通知・問題ビューにつなぐ。
import { detectLanguage } from "../i18n";
import { commands, events } from "../ipc";
import { reportProblem } from "../shell/problems";
import { notify } from "../shell/services";
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

export const extensionHost = createExtensionHost({
  list,
  doc: document,
  container: createContainer(),
  base: base(),
  locale: () => detectLanguage(),
  // Host API の実装は US3。それまでは、どの呼び出しも「未実装」で返す。
  handle: async (request) => {
    throw Object.assign(new Error(`not implemented: ${request.m}`), {
      code: "Internal",
    });
  },
  report: (level, text, extensionId) => {
    reportProblem({
      code: "extension.failure",
      source: extensionId,
      message: text,
    });
    notify(level, `${extensionId}: ${text}`, { source: extensionId });
  },
});

/** 起動時に 1 回。登録簿の変更（導入・削除・有効 / 無効）でも読み直す。 */
export function startExtensionHost(): void {
  void extensionHost.startup().catch(() => {});
  void events.extensionsChanged
    .listen(() => void extensionHost.refresh().catch(() => {}))
    .catch(() => {});
}
