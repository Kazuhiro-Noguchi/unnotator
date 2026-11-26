import { afterEach, describe, expect, it, vi } from "vitest";
import en from "./en.json";
import {
  currentLanguage,
  detectLanguage,
  format,
  onLanguageChange,
  resolveLanguage,
  setLanguage,
  t,
} from "./index";
import ja from "./ja.json";

describe("i18n", () => {
  it("ja と en のキーの集合が一致する", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });

  it("app.title が両言語で空でない文字列を返す", () => {
    expect(t("app.title", "ja")).not.toBe("");
    expect(t("app.title", "en")).not.toBe("");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage("ja");
  });

  it("言語のシグナルを変えると t の結果が変わる", () => {
    setLanguage("en");
    expect(currentLanguage()).toBe("en");
    expect(t("app.title")).toBe(t("app.title", "en"));
    setLanguage("ja");
    expect(currentLanguage()).toBe("ja");
  });

  it("言語の変更を購読できる", () => {
    const seen: string[] = [];
    const off = onLanguageChange((l) => seen.push(l));
    setLanguage("en");
    setLanguage("en");
    setLanguage("ja");
    off();
    setLanguage("en");
    expect(seen).toEqual(["en", "ja"]);
  });

  it("system は OS の言語に従い、日英以外は ja", () => {
    vi.stubGlobal("navigator", { language: "en-GB" });
    expect(resolveLanguage("system")).toBe("en");
    vi.stubGlobal("navigator", { language: "de" });
    expect(resolveLanguage("system")).toBe("ja");
    expect(resolveLanguage("en")).toBe("en");
    expect(resolveLanguage("ja")).toBe("ja");
  });

  it("{name} の補間", () => {
    expect(format("こんにちは {name}、{n} 件", { name: "A", n: 3 })).toBe(
      "こんにちは A、3 件",
    );
    expect(format("{missing}", {})).toBe("{missing}");
  });

  it("言語を省略したときは navigator.language で選び、既定は ja", () => {
    vi.stubGlobal("navigator", { language: "fr-FR" });
    expect(detectLanguage()).toBe("ja");
    vi.stubGlobal("navigator", { language: "en-US" });
    expect(detectLanguage()).toBe("en");
  });
});
