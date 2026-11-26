// 利用者の設定 `ui.*` の読み書き（specs/006-shell-layout/contracts/settings-keys.md）。
// 画面は user 層だけを読み書きする。不正な値は既定に戻し、`settings.invalid` を報告する。
import { format, t } from "../../i18n";
import type { NotifyLevel, ProblemSink } from "../types";

export type ThemeChoice = "system" | "light" | "dark";
export type LanguageChoice = "system" | "ja" | "en";

export interface UiSettings {
  theme: ThemeChoice;
  language: LanguageChoice;
  /** 形の検査と補正は `layout/state.ts`。無ければ undefined。 */
  layout: unknown;
  quickAccess: string[];
  /** 要素ごとの検査は `keys/keymap.ts`。 */
  keybindings: unknown[];
  recentProjects: string[];
}

export type UiKey =
  | "ui.theme"
  | "ui.language"
  | "ui.layout"
  | "ui.quickAccess"
  | "ui.keybindings"
  | "ui.recentProjects";

export interface SettingsPort {
  readUserLayer(): Promise<Record<string, unknown>>;
  write(key: UiKey | string, value: unknown): Promise<void>;
}

export const DEFAULT_QUICK_ACCESS = [
  "core.undo",
  "core.redo",
  "core.project.save",
];
export const QUICK_ACCESS_MAX = 20;
export const RECENT_PROJECTS_MAX = 10;
const SAVE_DEBOUNCE_MS = 300;

const THEMES: readonly string[] = ["system", "light", "dark"];
const LANGUAGES: readonly string[] = ["system", "ja", "en"];

function uniqueStrings(list: unknown[], max: number): string[] {
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === "string" && item !== "" && !out.includes(item)) {
      out.push(item);
    }
    if (out.length >= max) break;
  }
  return out;
}

export async function loadUiSettings(
  port: SettingsPort,
  report: ProblemSink,
): Promise<UiSettings> {
  let layer: Record<string, unknown> = {};
  try {
    layer = await port.readUserLayer();
  } catch (error) {
    report({
      code: "settings.invalid",
      source: "core",
      message: "利用者の設定を読めなかったので、既定で起動する",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const invalid = (key: string) =>
    report({
      code: "settings.invalid",
      source: "core",
      message: `設定の値が正しくないので既定に戻した: ${key}`,
    });

  const choice = <T extends string>(
    key: UiKey,
    allowed: readonly string[],
  ): T => {
    const value = layer[key];
    if (value === undefined) return "system" as T;
    if (typeof value === "string" && allowed.includes(value)) return value as T;
    invalid(key);
    return "system" as T;
  };

  const strings = (key: UiKey, max: number, fallback: string[]): string[] => {
    const value = layer[key];
    if (value === undefined) return fallback;
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      return uniqueStrings(value, max);
    }
    invalid(key);
    return fallback;
  };

  let keybindings: unknown[] = [];
  if (layer["ui.keybindings"] !== undefined) {
    if (Array.isArray(layer["ui.keybindings"]))
      keybindings = layer["ui.keybindings"];
    else invalid("ui.keybindings");
  }

  return {
    theme: choice<ThemeChoice>("ui.theme", THEMES),
    language: choice<LanguageChoice>("ui.language", LANGUAGES),
    layout: layer["ui.layout"],
    quickAccess: strings("ui.quickAccess", QUICK_ACCESS_MAX, [
      ...DEFAULT_QUICK_ACCESS,
    ]),
    keybindings,
    recentProjects: strings("ui.recentProjects", RECENT_PROJECTS_MAX, []),
  };
}

/** 設定の保存。同じキーは 300 ミリ秒でまとめ、最後の値だけ書く。 */
export function createUiSettingsWriter(
  port: SettingsPort,
  report: ProblemSink,
  notify: (level: NotifyLevel, text: string) => void,
) {
  const pending = new Map<string, unknown>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const entries = [...pending];
    pending.clear();
    for (const [key, value] of entries) {
      try {
        await port.write(key, value);
      } catch (error) {
        report({
          code: "settings.invalid",
          source: "core",
          message: `設定を保存できなかった: ${key}`,
          detail: error instanceof Error ? error.message : String(error),
        });
        notify("error", format(t("settings.saveFailed"), { key }));
      }
    }
  }

  return {
    save(key: UiKey | string, value: unknown): void {
      pending.set(key, value);
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, SAVE_DEBOUNCE_MS);
      }
    },
    flush,
  };
}
