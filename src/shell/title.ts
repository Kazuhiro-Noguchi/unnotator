import { type Language, t } from "../i18n";
import type { Title } from "./types";

/** 表示名を、指定の言語で解決する。その言語が無ければ、もう一方の言語を使う。 */
export function resolveTitle(title: Title, language: Language): string {
  if ("key" in title) return t(title.key, language);
  const other: Language = language === "ja" ? "en" : "ja";
  return title[language] ?? title[other] ?? "";
}

/** 検索用に、両言語の表示名を返す（重複と空は除く）。 */
export function allTitles(title: Title): string[] {
  const names = [resolveTitle(title, "ja"), resolveTitle(title, "en")];
  return [...new Set(names.filter((name) => name !== ""))];
}
