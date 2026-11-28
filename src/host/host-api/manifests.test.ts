import { describe, expect, it } from "vitest";
import { createManifestIndex, parseManifest } from "./manifests";

const manifest = JSON.stringify({
  id: "com.example.a",
  version: "1.0.0",
  permissions: ["assets.read", 3],
  extensionDependencies: { "com.example.base": "^1.0.0" },
  contributes: {
    commands: [{ id: "run", title: "x" }, { nope: 1 }],
    annotationTypes: [{ id: "rect" }],
    settings: { type: "object", properties: { "a.size": { type: "number" } } },
    views: [{ id: "list" }],
  },
});

describe("マニフェストの解析", () => {
  it("権限・依存・宣言した名前・設定のキーを取り出す", () => {
    const facts = parseManifest({ id: "com.example.a", manifest });
    expect(facts?.permissions).toEqual(["assets.read"]);
    expect(facts?.extensionDependencies).toEqual(["com.example.base"]);
    expect(facts?.contributes.commands).toEqual(["run"]);
    expect(facts?.contributes.annotationTypes).toEqual(["rect"]);
    expect(facts?.contributes.views).toEqual(["list"]);
    expect(facts?.contributes.exporters).toEqual([]);
    expect(facts?.settingKeys).toEqual(["a.size"]);
  });

  it("読めないマニフェストは null", () => {
    expect(parseManifest({ id: "x", manifest: null })).toBeNull();
    expect(parseManifest({ id: "x", manifest: "{oops" })).toBeNull();
    expect(parseManifest({ id: "x", manifest: "[]" })).toBeNull();
  });

  it("索引は、一覧が変わると新しい値を返す", () => {
    let list = [{ id: "com.example.a", manifest }];
    const index = createManifestIndex(() => list);
    expect(index.get("com.example.a")?.contributes.commands).toEqual(["run"]);
    expect(index.get("com.example.zz")).toBeUndefined();
    list = [
      {
        id: "com.example.a",
        manifest: JSON.stringify({ contributes: { commands: [{ id: "b" }] } }),
      },
    ];
    expect(index.get("com.example.a")?.contributes.commands).toEqual(["b"]);
    expect(index.all()).toHaveLength(1);
  });
});
