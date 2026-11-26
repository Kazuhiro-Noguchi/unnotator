import en from "./en.json";
import ja from "./ja.json";

export type MessageKey = keyof typeof ja;
export type Language = "ja" | "en";
export type LanguageChoice = "system" | Language;

const catalogs: Record<Language, Record<MessageKey, string>> = { ja, en };

/** `navigator.language` から言語を選ぶ。既定は日本語。 */
export function detectLanguage(): Language {
  const tag = typeof navigator === "undefined" ? "ja" : navigator.language;
  return tag.toLowerCase().startsWith("en") ? "en" : "ja";
}

/** 設定の選択（`system` は OS の言語）を、実際の言語にする。 */
export function resolveLanguage(choice: LanguageChoice): Language {
  return choice === "system" ? detectLanguage() : choice;
}

let current: Language = detectLanguage();
const listeners = new Set<(language: Language) => void>();

export function currentLanguage(): Language {
  return current;
}

export function setLanguage(language: Language): void {
  if (language === current) return;
  current = language;
  for (const listener of [...listeners]) listener(language);
}

export function onLanguageChange(
  listener: (language: Language) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function t(key: MessageKey, language: Language = current): string {
  return catalogs[language][key];
}

/** `{name}` を値に置き換える。値が無いものはそのまま残す。 */
export function format(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}
