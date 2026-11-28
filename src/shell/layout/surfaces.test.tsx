// @vitest-environment happy-dom
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectSurfaces,
  createPlacement,
  type EditorPreferences,
} from "../../host/placement";
import type {
  SurfaceHandle,
  SurfaceOpener,
  SurfaceOpenRequest,
} from "../../host/placement-frame";
import type { ExtensionInfo } from "../../host/service";
import type { AssetRow } from "../../ipc";
import { createContext } from "../when/context";
import { createResolveSurface, syncExtensionViews, toAsset } from "./surfaces";
import { createViewRegistry } from "./views";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const row = (patch: Partial<AssetRow> = {}): AssetRow => ({
  id: "a1",
  root_key: "",
  rel_path: "dir/p.png",
  media_type: "img/png",
  file_size: 10,
  mtime_ms: 5,
  status: "todo",
  missing: false,
  ...patch,
});

function info(id: string, contributes: Record<string, unknown>): ExtensionInfo {
  return {
    id,
    version: "0.0.1",
    status: "enabled",
    manifest: JSON.stringify({ id, contributes }),
  };
}

const editor = (ext: string, local: string, priority = "default") => ({
  id: local,
  title: `T ${local}`,
  mediaTypes: ["img/png"],
  entry: `dist/${local}.js`,
  priority,
  qualifiedId: `${ext}/${local}`,
});

function fakeOpener() {
  const requests: SurfaceOpenRequest[] = [];
  const disposed: string[] = [];
  const opener: SurfaceOpener = {
    open(request) {
      requests.push(request);
      const handle: SurfaceHandle = {
        dispose: () => void disposed.push(request.surfaceId),
        emit: () => {},
      };
      return handle;
    },
  };
  return { opener, requests, disposed };
}

function setup(infos: ExtensionInfo[]) {
  const surfaces = collectSurfaces(infos);
  const map = new Map<string, string>();
  const prefs: EditorPreferences = {
    get: (m) => map.get(m),
    set: (m, id) => void map.set(m, id),
  };
  const placement = createPlacement({
    surfaces: () => surfaces,
    preferences: prefs,
  });
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);
  const fake = fakeOpener();
  const resolveSurface = createResolveSurface({
    placement,
    opener: fake.opener,
    nameOf: (id) => id,
    version,
    bump,
  });
  return { placement, resolveSurface, bump, map, ...fake };
}

describe("toAsset", () => {
  it("AssetRow を plugin-api の Asset の形にする", () => {
    expect(toAsset(row({ file_size: null, mtime_ms: null }))).toMatchObject({
      id: "a1",
      rootKey: "",
      relPath: "dir/p.png",
      mediaType: "img/png",
      fileSize: 0,
      mtimeMs: 0,
      status: "todo",
      missing: false,
    });
  });
});

describe("createResolveSurface（エディター領域への差し込み）", () => {
  it("対応するエディターがあれば、画面の枠を作る（アセットとアイテムを渡す）", async () => {
    const s = setup([info("x.a", { editors: [editor("x.a", "main")] })]);
    dispose = render(
      () => <>{s.resolveSurface(row(), "page:2")}</>,
      document.body,
    );
    await flush();
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({
      extensionId: "x.a",
      surfaceId: "x.a/main",
      role: "editor",
      entry: "dist/main.js",
      ctx: { asset: { id: "a1" }, itemKey: "page:2" },
    });
  });

  it("対応が無い・リンク切れなら null（汎用プレビューに落ちる）", () => {
    const s = setup([info("x.a", { editors: [editor("x.a", "main")] })]);
    expect(s.resolveSurface(row({ media_type: "img/jpg" }), null)).toBeNull();
    expect(s.resolveSurface(row({ media_type: null }), null)).toBeNull();
    expect(s.resolveSurface(row({ missing: true }), null)).toBeNull();
  });

  it("画面が失敗したら、その画面を外して選び直す（次の候補、無ければ null）", async () => {
    const s = setup([
      info("x.a", { editors: [editor("x.a", "e1"), editor("x.a", "e2")] }),
    ]);
    dispose = render(() => <>{s.resolveSurface(row(), null)}</>, document.body);
    await flush();
    expect(s.requests.map((r) => r.surfaceId)).toEqual(["x.a/e1"]);
    s.requests[0]?.onState({ kind: "failed", message: "boom" });
    await flush();
    expect(s.requests.map((r) => r.surfaceId)).toEqual(["x.a/e1", "x.a/e2"]);
    expect(s.disposed).toContain("x.a/e1");
  });

  it("候補が 2 つ以上あるとき、切り替えの選択肢を出す。選ぶと既定として保存し、前の枠を取り除く", async () => {
    const s = setup([
      info("x.a", {
        editors: [editor("x.a", "e1"), editor("x.a", "e2", "option")],
      }),
    ]);
    dispose = render(() => <>{s.resolveSurface(row(), null)}</>, document.body);
    await flush();
    const select = document.querySelector(
      "select.surface-switcher",
    ) as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect([...select.options].map((o) => o.value)).toEqual([
      "x.a/e1",
      "x.a/e2",
    ]);
    select.value = "x.a/e2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(s.map.get("img/png")).toBe("x.a/e2");
    expect(s.disposed).toContain("x.a/e1");
    expect(s.requests.at(-1)?.surfaceId).toBe("x.a/e2");
  });

  it("候補が 1 つなら、切り替えの選択肢を出さない", async () => {
    const s = setup([info("x.a", { editors: [editor("x.a", "e1")] })]);
    dispose = render(() => <>{s.resolveSurface(row(), null)}</>, document.body);
    await flush();
    expect(document.querySelector(".surface-switcher")).toBeNull();
  });

  it("プレビュー用の画面は role=preview で作る", async () => {
    const s = setup([
      info("x.a", {
        previewers: [{ id: "pv", mediaTypes: ["img/png"], entry: "pv.js" }],
      }),
    ]);
    dispose = render(() => <>{s.resolveSurface(row(), null)}</>, document.body);
    await flush();
    expect(s.requests[0]).toMatchObject({
      role: "preview",
      surfaceId: "x.a/pv",
    });
  });
});

describe("syncExtensionViews（拡張機能のビューを配置する。FR-008）", () => {
  function viewSetup() {
    const registry = createViewRegistry(createContext(), vi.fn());
    const fake = fakeOpener();
    const sync = (infos: ExtensionInfo[]) =>
      syncExtensionViews(registry, collectSurfaces(infos).views, {
        opener: fake.opener,
        nameOf: (id) => id,
      });
    return { registry, sync, ...fake };
  }
  const viewInfo = (ext: string, location = "panel") =>
    info(ext, {
      views: [
        {
          id: "list",
          title: "List",
          location,
          entry: "dist/list.js",
          icon: "$(list)",
        },
      ],
    });

  it("宣言された場所に、完全な名前で登録する。描くと role=view の枠ができる", async () => {
    const s = viewSetup();
    s.sync([viewInfo("x.a", "panel")]);
    const view = s.registry.get("x.a/list");
    expect(view).toMatchObject({
      location: "panel",
      source: "ext-surface:x.a",
    });
    dispose = render(() => <>{view?.render()}</>, document.body);
    await flush();
    expect(s.requests[0]).toMatchObject({
      role: "view",
      extensionId: "x.a",
      entry: "dist/list.js",
    });
  });

  it("拡張機能が無効になったら、そのビューを取り除く", () => {
    const s = viewSetup();
    s.sync([viewInfo("x.a"), viewInfo("x.b", "secondarySidebar")]);
    expect(s.registry.ids("panel")).toContain("x.a/list");
    s.sync([viewInfo("x.b", "secondarySidebar")]);
    expect(s.registry.get("x.a/list")).toBeUndefined();
    expect(s.registry.get("x.b/list")).toBeDefined();
  });

  it("ビューを閉じる（描画を外す）と、枠を取り除く", async () => {
    const s = viewSetup();
    s.sync([viewInfo("x.a")]);
    dispose = render(
      () => <>{s.registry.get("x.a/list")?.render()}</>,
      document.body,
    );
    await flush();
    dispose();
    dispose = undefined;
    expect(s.disposed).toEqual(["x.a/list"]);
  });
});
