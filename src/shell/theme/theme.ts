// テーマ（ライト・ダーク・OS 連動）と言語の適用（specs/006-shell-layout/research.md R10・R11）。
import {
  type Language,
  type LanguageChoice,
  resolveLanguage,
  setLanguage,
} from "../../i18n";
import type { Context } from "../types";

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export function resolveTheme(
  choice: ThemeChoice,
  prefersDark: boolean,
): ResolvedTheme {
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
}

export interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener(
    type: "change",
    listener: (event: { matches: boolean }) => void,
  ): void;
  removeEventListener(
    type: "change",
    listener: (event: { matches: boolean }) => void,
  ): void;
}

export interface AppearanceDeps {
  ctx: Context;
  root: { setAttribute(name: string, value: string): void };
  media: MediaQueryLike;
  /** 設定への保存（`ui.theme` / `ui.language`）。 */
  save: (key: string, value: unknown) => void;
}

export function createAppearance({ ctx, root, media, save }: AppearanceDeps) {
  let choice: ThemeChoice = "system";
  let languageChoice: LanguageChoice = "system";
  let listener: ((event: { matches: boolean }) => void) | null = null;

  function detach(): void {
    if (listener) media.removeEventListener("change", listener);
    listener = null;
  }

  function show(dark: boolean): void {
    const theme = resolveTheme(choice, dark);
    root.setAttribute("data-theme", theme);
    ctx.set("theme", theme);
  }

  function applyTheme(next: ThemeChoice): void {
    choice = next;
    detach();
    show(media.matches);
    if (next === "system") {
      listener = (event) => show(event.matches);
      media.addEventListener("change", listener);
    }
  }

  function applyLanguage(next: LanguageChoice): Language {
    languageChoice = next;
    const language = resolveLanguage(next);
    setLanguage(language);
    ctx.set("language", language);
    root.setAttribute("lang", language);
    return language;
  }

  return {
    applyTheme,
    setTheme(next: ThemeChoice): void {
      applyTheme(next);
      save("ui.theme", next);
    },
    applyLanguage,
    setLanguage(next: LanguageChoice): void {
      applyLanguage(next);
      save("ui.language", next);
    },
    /** いま選んでいる値（設定画面の表示用）。 */
    current: (): { theme: ThemeChoice; language: LanguageChoice } => ({
      theme: choice,
      language: languageChoice,
    }),
    dispose: detach,
  };
}

export type Appearance = ReturnType<typeof createAppearance>;
