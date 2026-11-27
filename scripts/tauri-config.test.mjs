import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const conf = read("../src-tauri/tauri.conf.json");
const capability = read("../src-tauri/capabilities/default.json");

describe("tauri.conf.json", () => {
  it("withGlobalTauri が false", () => {
    expect(conf.app.withGlobalTauri).toBe(false);
  });

  it.each(["csp", "devCsp"])("%s に外部の接続先が無い", (key) => {
    const csp = conf.app.security[key];
    // アプリ自身の通り道（ipc と unno://）だけは、localhost の別名として許す
    const withoutIpc = csp
      .replaceAll("http://ipc.localhost", "")
      .replaceAll("http://unno.localhost", "");
    expect(withoutIpc).not.toMatch(/\bhttps?:/);
    expect(withoutIpc).not.toMatch(/\bwss?:\/\/(?!localhost:1420)/);
    expect(csp).not.toMatch(/\*/);
  });

  it.each(["csp", "devCsp"])(
    "%s は unno:// を、読み込み系の指示にだけ足している",
    (key) => {
      const csp = conf.app.security[key];
      const directive = (name) =>
        csp
          .split(";")
          .map((d) => d.trim())
          .find((d) => d.startsWith(`${name} `)) ?? "";
      for (const name of [
        "script-src",
        "img-src",
        "media-src",
        "font-src",
        "frame-src",
        "connect-src",
      ]) {
        expect(directive(name), name).toMatch(/\bunno:/);
        expect(directive(name), name).toMatch(/http:\/\/unno\.localhost/);
      }
      // 実行の許可は広げない
      expect(csp).not.toMatch(/unsafe-eval/);
      expect(directive("script-src")).not.toMatch(/unsafe-inline/);
      expect(directive("style-src")).not.toMatch(/unno:/);
      expect(csp).toMatch(/default-src 'self'/);
      expect(csp).toMatch(/object-src 'none'/);
      expect(csp).toMatch(/frame-ancestors 'none'/);
    },
  );

  it("本番の csp に ws: が無い", () => {
    expect(conf.app.security.csp).not.toMatch(/\bws:/);
  });
});

describe("capabilities/default.json", () => {
  it("permissions が core:default・タイトルの変更・ウィンドウの破棄（確認後に閉じる）・フォルダ選択（dialog:allow-open）だけ", () => {
    expect([...capability.permissions].sort()).toEqual([
      "core:default",
      "core:window:allow-destroy",
      "core:window:allow-set-title",
      "dialog:allow-open",
    ]);
  });
});
