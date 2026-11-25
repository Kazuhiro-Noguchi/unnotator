import { afterEach, describe, expect, it, vi } from "vitest";
import en from "./en.json";
import { detectLanguage, t } from "./index";
import ja from "./ja.json";

describe("i18n", () => {
  it("ja と en のキーの集合が一致する", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });

  it("app.title が両言語で空でない文字列を返す", () => {
    expect(t("app.title", "ja")).not.toBe("");
    expect(t("app.title", "en")).not.toBe("");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("言語を省略したときは navigator.language で選び、既定は ja", () => {
    vi.stubGlobal("navigator", { language: "fr-FR" });
    expect(detectLanguage()).toBe("ja");
    vi.stubGlobal("navigator", { language: "en-US" });
    expect(detectLanguage()).toBe("en");
  });
});
