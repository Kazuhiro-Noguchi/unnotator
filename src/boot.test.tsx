// @vitest-environment happy-dom
// 起動時の読み込み（モジュールの初期化の順）を確かめる。循環 import で、画面が出ないまま落ちることを防ぐ。
// 各モジュールのテストでは、アプリ全体の結線（`App.tsx` が読む `instance` 類）の初期化の順を確かめられない。
import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
  once: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("Tauri の外");
  }),
  transformCallback: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: async () => {},
    onCloseRequested: async () => () => {},
    destroy: async () => {},
  }),
}));

it("App を読み込める（初期化の順の循環で、起動時に落ちない）", async () => {
  const mod = await import("./App");
  expect(typeof mod.App).toBe("function");
});
