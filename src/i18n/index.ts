import en from "./en.json";
import ja from "./ja.json";

export type MessageKey = keyof typeof ja;
export type Language = "ja" | "en";

const catalogs: Record<Language, Record<MessageKey, string>> = { ja, en };

/** `navigator.language` から言語を選ぶ。既定は日本語。 */
export function detectLanguage(): Language {
  const tag = typeof navigator === "undefined" ? "ja" : navigator.language;
  return tag.toLowerCase().startsWith("en") ? "en" : "ja";
}

export function t(
  key: MessageKey,
  language: Language = detectLanguage(),
): string {
  return catalogs[language][key];
}
