import { describe, expect, it } from "vitest";
import {
  collectSurfaces,
  createPlacement,
  type EditorPreferences,
  type Surfaces,
} from "./placement";
import type { ExtensionInfo } from "./service";

function info(
  id: string,
  contributes: Record<string, unknown>,
  status = "enabled",
): ExtensionInfo {
  return {
    id,
    version: "0.0.1",
    status,
    manifest: JSON.stringify({ id, contributes }),
  };
}

function memoryPreferences(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const prefs: EditorPreferences = {
    get: (mediaType) => map.get(mediaType),
    set: (mediaType, editorId) => void map.set(mediaType, editorId),
  };
  return { prefs, map };
}

function setup(surfaces: Surfaces, initial: Record<string, string> = {}) {
  const { prefs, map } = memoryPreferences(initial);
  const placement = createPlacement({
    surfaces: () => surfaces,
    preferences: prefs,
  });
  return { placement, map };
}

const editor = (
  ext: string,
  local: string,
  priority?: "default" | "option",
) => ({
  id: local,
  title: local,
  mediaTypes: [`img/png`],
  entry: `dist/${local}.js`,
  ...(priority === undefined ? {} : { priority }),
  qualifiedId: `${ext}/${local}`,
});

describe("collectSurfaces", () => {
  it("有効な拡張機能のエディター・プレビュー・ビューだけを、完全な名前つきで集める", () => {
    const surfaces = collectSurfaces([
      info("x.a", {
        editors: [editor("x.a", "main")],
        previewers: [
          { id: "pv", mediaTypes: ["img/png"], entry: "dist/pv.js" },
        ],
        views: [
          {
            id: "list",
            title: "List",
            location: "primarySidebar",
            entry: "dist/list.js",
            icon: "$(list)",
          },
        ],
      }),
      info("x.off", { editors: [editor("x.off", "main")] }, "disabled"),
      { id: "x.bad", version: "0.0.1", status: "enabled", manifest: "{" },
    ]);
    expect(surfaces.editors.map((e) => e.id)).toEqual(["x.a/main"]);
    expect(surfaces.editors[0]).toMatchObject({
      extensionId: "x.a",
      localId: "main",
      entry: "dist/main.js",
      priority: "default",
    });
    expect(surfaces.previewers.map((p) => p.id)).toEqual(["x.a/pv"]);
    expect(surfaces.views.map((v) => [v.id, v.location])).toEqual([
      ["x.a/list", "primarySidebar"],
    ]);
  });

  it("修飾されていない媒体種別の参照は、宣言した拡張機能の名前で補う", () => {
    const surfaces = collectSurfaces([
      info("x.a", {
        editors: [{ id: "e", title: "E", mediaTypes: ["png"], entry: "e.js" }],
      }),
    ]);
    expect(surfaces.editors[0]?.mediaTypes).toEqual(["x.a/png"]);
  });
});

describe("エディターの選択（FR-006）", () => {
  const surfaces = (): Surfaces =>
    collectSurfaces([
      info("x.a", { editors: [editor("x.a", "opt", "option")] }),
      info("x.b", { editors: [editor("x.b", "main", "default")] }),
      info("x.c", { editors: [editor("x.c", "other", "default")] }),
    ]);

  it("default の優先度を option より先に選び、同じなら登録の順で 1 つ選ぶ", () => {
    const { placement } = setup(surfaces());
    const result = placement.resolve("img/png");
    expect(result.kind).toBe("editor");
    if (result.kind === "editor") {
      expect(result.editor.id).toBe("x.b/main");
      expect(result.alternatives.map((e) => e.id)).toEqual([
        "x.b/main",
        "x.c/other",
        "x.a/opt",
      ]);
    }
  });

  it("保存済みの既定があれば、それを先に選ぶ", () => {
    const { placement } = setup(surfaces(), { "img/png": "x.a/opt" });
    const result = placement.resolve("img/png");
    expect(result.kind === "editor" && result.editor.id).toBe("x.a/opt");
  });

  it("保存済みの既定が今は無ければ、優先度の順に戻る", () => {
    const { placement } = setup(surfaces(), { "img/png": "x.gone/e" });
    const result = placement.resolve("img/png");
    expect(result.kind === "editor" && result.editor.id).toBe("x.b/main");
  });

  it("「別のエディターで開く」は、保存せずにそのエディターで開く", () => {
    const { placement, map } = setup(surfaces());
    const result = placement.resolve("img/png", { use: "x.c/other" });
    expect(result.kind === "editor" && result.editor.id).toBe("x.c/other");
    expect(map.size).toBe(0);
  });

  it("対応しない媒体種別の指定は無視する", () => {
    const { placement } = setup(surfaces());
    const result = placement.resolve("img/png", { use: "x.zzz/none" });
    expect(result.kind === "editor" && result.editor.id).toBe("x.b/main");
  });

  it("既定の変更は設定の保存先へ渡す", () => {
    const { placement, map } = setup(surfaces());
    placement.setDefault("img/png", "x.c/other");
    expect(map.get("img/png")).toBe("x.c/other");
    const result = placement.resolve("img/png");
    expect(result.kind === "editor" && result.editor.id).toBe("x.c/other");
  });

  it("対応しないエディターは既定にできない", () => {
    const { placement, map } = setup(surfaces());
    expect(() => placement.setDefault("img/png", "x.zzz/none")).toThrow();
    expect(map.size).toBe(0);
  });
});

describe("対応が無い・失敗したとき（FR-007）", () => {
  it("エディターが無ければ、プレビュー用の画面があればそれ、無ければ汎用プレビュー", () => {
    const withPreviewer = setup(
      collectSurfaces([
        info("x.a", {
          previewers: [{ id: "pv", mediaTypes: ["img/png"], entry: "pv.js" }],
        }),
      ]),
    );
    const r = withPreviewer.placement.resolve("img/png");
    expect(r.kind === "previewer" && r.previewer.id).toBe("x.a/pv");
    expect(withPreviewer.placement.resolve("img/jpg")).toEqual({
      kind: "generic",
    });
    expect(withPreviewer.placement.resolve(null)).toEqual({ kind: "generic" });
  });

  it("失敗したエディターは外し、次の候補、無ければプレビュー、最後に汎用プレビューへ落とす", () => {
    const { placement } = setup(
      collectSurfaces([
        info("x.a", {
          editors: [editor("x.a", "e1"), editor("x.a", "e2")],
          previewers: [{ id: "pv", mediaTypes: ["img/png"], entry: "pv.js" }],
        }),
      ]),
    );
    placement.reportFailure("x.a/e1");
    const second = placement.resolve("img/png");
    expect(second.kind === "editor" && second.editor.id).toBe("x.a/e2");
    placement.reportFailure("x.a/e2");
    expect(placement.resolve("img/png").kind).toBe("previewer");
    placement.reportFailure("x.a/pv");
    expect(placement.resolve("img/png")).toEqual({ kind: "generic" });
  });

  it("拡張機能を読み直したら、その拡張機能の失敗の記録を消す", () => {
    const { placement } = setup(
      collectSurfaces([info("x.a", { editors: [editor("x.a", "e1")] })]),
    );
    placement.reportFailure("x.a/e1");
    expect(placement.resolve("img/png")).toEqual({ kind: "generic" });
    placement.clearFailures("x.a");
    expect(placement.resolve("img/png").kind).toBe("editor");
  });
});
