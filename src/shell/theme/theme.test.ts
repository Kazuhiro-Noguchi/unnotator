import { afterEach, describe, expect, it, vi } from "vitest";
import { currentLanguage, setLanguage } from "../../i18n";
import { createContext } from "../when/context";
import { createAppearance, resolveTheme } from "./theme";

function fakeMedia(initialDark: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const state = { matches: initialDark };
  return {
    state,
    media: {
      get matches() {
        return state.matches;
      },
      addEventListener: (_: "change", fn: (e: { matches: boolean }) => void) =>
        listeners.add(fn),
      removeEventListener: (
        _: "change",
        fn: (e: { matches: boolean }) => void,
      ) => listeners.delete(fn),
    },
    flip(dark: boolean) {
      state.matches = dark;
      for (const fn of [...listeners]) fn({ matches: dark });
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function setup(dark = false) {
  const ctx = createContext();
  const attributes: Record<string, string> = {};
  const root = {
    setAttribute: (name: string, value: string) => {
      attributes[name] = value;
    },
  };
  const media = fakeMedia(dark);
  const save = vi.fn();
  const appearance = createAppearance({ ctx, root, media: media.media, save });
  return { ctx, attributes, media, save, appearance };
}

afterEach(() => setLanguage("ja"));

describe("テーマ", () => {
  it("resolveTheme: system は OS に従う", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("選択が data-theme に反映され、コンテキストと ui.theme に反映される", () => {
    const { appearance, attributes, ctx, save } = setup(false);
    appearance.setTheme("dark");
    expect(attributes["data-theme"]).toBe("dark");
    expect(ctx.get("theme")).toBe("dark");
    expect(save).toHaveBeenCalledWith("ui.theme", "dark");
    appearance.setTheme("light");
    expect(attributes["data-theme"]).toBe("light");
    expect(ctx.get("theme")).toBe("light");
  });

  it("system は、OS の設定の変更に再起動なしで追従する", () => {
    const { appearance, attributes, media, ctx } = setup(false);
    appearance.setTheme("system");
    expect(attributes["data-theme"]).toBe("light");
    media.flip(true);
    expect(attributes["data-theme"]).toBe("dark");
    expect(ctx.get("theme")).toBe("dark");
    media.flip(false);
    expect(attributes["data-theme"]).toBe("light");
  });

  it("light / dark を選んでいる間は、OS の変更に影響されない", () => {
    const { appearance, attributes, media } = setup(false);
    appearance.setTheme("light");
    media.flip(true);
    expect(attributes["data-theme"]).toBe("light");
  });

  it("apply は、保存せずに反映する（設定の読み込み用）", () => {
    const { appearance, attributes, save } = setup(true);
    appearance.applyTheme("system");
    expect(attributes["data-theme"]).toBe("dark");
    expect(save).not.toHaveBeenCalled();
  });

  it("dispose で、OS の変更の購読を外す", () => {
    const { appearance, media } = setup(false);
    appearance.setTheme("system");
    expect(media.listenerCount).toBe(1);
    appearance.dispose();
    expect(media.listenerCount).toBe(0);
  });

  it("選択をやり直しても、購読が増えない", () => {
    const { appearance, media } = setup(false);
    appearance.setTheme("system");
    appearance.setTheme("system");
    appearance.setTheme("dark");
    appearance.setTheme("system");
    expect(media.listenerCount).toBe(1);
  });
});

describe("言語", () => {
  it("選択が、表示の言語・コンテキスト・ui.language に反映される", () => {
    const { appearance, ctx, save } = setup();
    appearance.setLanguage("en");
    expect(currentLanguage()).toBe("en");
    expect(ctx.get("language")).toBe("en");
    expect(save).toHaveBeenCalledWith("ui.language", "en");
    appearance.setLanguage("ja");
    expect(currentLanguage()).toBe("ja");
  });

  it("system は OS の言語に従い、日英以外は ja", () => {
    const { appearance } = setup();
    vi.stubGlobal("navigator", { language: "en-US" });
    appearance.setLanguage("system");
    expect(currentLanguage()).toBe("en");
    vi.stubGlobal("navigator", { language: "fr" });
    appearance.setLanguage("system");
    expect(currentLanguage()).toBe("ja");
    vi.unstubAllGlobals();
  });

  it("applyLanguage は、保存しない", () => {
    const { appearance, save } = setup();
    appearance.applyLanguage("en");
    expect(save).not.toHaveBeenCalled();
    expect(currentLanguage()).toBe("en");
  });
});
