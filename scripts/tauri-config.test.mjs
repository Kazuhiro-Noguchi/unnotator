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
    const withoutIpc = csp.replaceAll("http://ipc.localhost", "");
    expect(withoutIpc).not.toMatch(/\bhttps?:/);
    expect(withoutIpc).not.toMatch(/\bwss?:\/\/(?!localhost:1420)/);
    expect(csp).not.toMatch(/\*/);
  });

  it("本番の csp に ws: が無い", () => {
    expect(conf.app.security.csp).not.toMatch(/\bws:/);
  });
});

describe("capabilities/default.json", () => {
  it("permissions が core:default と core:window:allow-set-title だけ", () => {
    expect([...capability.permissions].sort()).toEqual([
      "core:default",
      "core:window:allow-set-title",
    ]);
  });
});
