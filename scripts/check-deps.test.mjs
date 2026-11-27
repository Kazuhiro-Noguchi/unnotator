import { describe, expect, it } from "vitest";
import {
  checkDirectVersions,
  checkMetadata,
  checkPreviewSource,
  checkProjectDataSource,
} from "./check-deps.mjs";

// 作り物の `cargo metadata` の出力を組み立てる。
function pkg(
  name,
  deps = [],
  manifestPath = name === "unnotator"
    ? "/r/src-tauri/Cargo.toml"
    : `/r/crates/${name}/Cargo.toml`,
) {
  return {
    id: name,
    name,
    manifest_path: manifestPath,
    dependencies: deps.map((d) => ({ name: d, req: "*" })),
  };
}

function metadata(packages, workspaceMembers = packages.map((p) => p.id)) {
  return { packages, workspace_members: workspaceMembers };
}

const good = [
  pkg("unnotator-core"),
  pkg("unnotator-extensions", ["unnotator-core"]),
  pkg("unnotator-worker", ["unnotator-core", "unnotator-extensions"]),
  pkg("unnotator", [
    "unnotator-core",
    "unnotator-extensions",
    "unnotator-worker",
    "tauri",
  ]),
  pkg("tauri"),
];

describe("checkMetadata", () => {
  it("許可された依存だけなら問題なし", () => {
    const members = [
      "unnotator-core",
      "unnotator-extensions",
      "unnotator-worker",
      "unnotator",
    ];
    expect(checkMetadata(metadata(good, members))).toEqual([]);
  });

  it("許可されない依存の辺を検出する", () => {
    const bad = good.map((p) =>
      p.name === "unnotator-core"
        ? pkg("unnotator-core", ["unnotator-worker"])
        : p,
    );
    const members = [
      "unnotator-core",
      "unnotator-extensions",
      "unnotator-worker",
      "unnotator",
    ];
    const problems = checkMetadata(metadata(bad, members));
    expect(problems.join("\n")).toContain("unnotator-core -> unnotator-worker");
  });

  it("crates/* が推移的に tauri に依存していたら検出する", () => {
    const bad = good.map((p) =>
      p.name === "unnotator-core" ? pkg("unnotator-core", ["helper"]) : p,
    );
    bad.push(pkg("helper", ["tauri-utils"]), pkg("tauri-utils"));
    const members = [
      "unnotator-core",
      "unnotator-extensions",
      "unnotator-worker",
      "unnotator",
    ];
    const problems = checkMetadata(metadata(bad, members));
    expect(problems.join("\n")).toContain("tauri-utils");
  });
});

describe("checkDirectVersions", () => {
  it("workspace = true と path だけなら問題なし", () => {
    const toml = [
      "[dependencies]",
      "serde = { workspace = true }",
      'unnotator-core = { path = "../core" }',
      "tracing.workspace = true",
      "[dev-dependencies]",
      "serde_json = { workspace = true }",
    ].join("\n");
    expect(checkDirectVersions("crates/x/Cargo.toml", toml)).toEqual([]);
  });

  it("版を直接書いた依存を検出する", () => {
    const toml = [
      "[dependencies]",
      'serde = "1.0"',
      'tokio = { version = "1", features = ["rt"] }',
    ].join("\n");
    const problems = checkDirectVersions("crates/x/Cargo.toml", toml);
    expect(problems.length).toBe(2);
    expect(problems.join("\n")).toContain("serde");
    expect(problems.join("\n")).toContain("tokio");
  });

  it("依存以外のセクションは見ない", () => {
    const toml = [
      "[package]",
      'version = "0.0.1"',
      "[lints]",
      "workspace = true",
    ].join("\n");
    expect(checkDirectVersions("crates/x/Cargo.toml", toml)).toEqual([]);
  });
});

describe("checkPreviewSource（src/preview/ はプロジェクトのデータを書かない）", () => {
  it("ipc の書き込み系の呼び出しを検出する", () => {
    const source = `import { commands } from "../ipc";\ncommands.applyCommand({});\ncommands.settingsSet("a", "b");`;
    const problems = checkPreviewSource("src/preview/x.ts", source);
    expect(problems.length).toBe(3);
  });

  it("許可は、型の import と、external.ts の openInDefaultApp だけ", () => {
    expect(
      checkPreviewSource(
        "src/preview/Preview.tsx",
        `import type { AssetRow } from "../ipc";`,
      ),
    ).toEqual([]);
    expect(
      checkPreviewSource(
        "src/preview/external.ts",
        `import { commands } from "../ipc";\nawait commands.openInDefaultApp(id);`,
      ),
    ).toEqual([]);
    expect(
      checkPreviewSource(
        "src/preview/external.ts",
        `import { commands } from "../ipc";\ncommands.undo();`,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("external.ts 以外で commands を import したら、検出する", () => {
    expect(
      checkPreviewSource(
        "src/preview/Preview.tsx",
        `import { commands } from "../ipc";\ncommands.openInDefaultApp(id);`,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("テストファイルは、検査しない", () => {
    expect(
      checkPreviewSource(
        "src/preview/Preview.test.tsx",
        `import { commands } from "../ipc";`,
      ),
    ).toEqual([]);
  });

  it("相対パスの深さが違っても、ipc の import を見つける", () => {
    expect(
      checkPreviewSource(
        "src/preview/sub/x.ts",
        `import { commands } from "../../ipc";`,
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("checkProjectDataSource（008: 画面は ipc を直接 import せず、project-data を通す）", () => {
  const value = `import { commands } from "../../ipc";\ncommands.labelsList();`;

  it("labels・properties・schema が ipc から値を import したら、検出する", () => {
    for (const dir of ["labels", "properties", "schema"]) {
      expect(
        checkProjectDataSource(`src/shell/${dir}/X.tsx`, value).length,
      ).toBeGreaterThan(0);
    }
  });

  it("型の import は、許す", () => {
    expect(
      checkProjectDataSource(
        "src/shell/labels/X.tsx",
        `import type { LabelRow } from "../../ipc";`,
      ),
    ).toEqual([]);
  });

  it("project-data は ipc を使える", () => {
    expect(
      checkProjectDataSource("src/shell/project-data/store.ts", value),
    ).toEqual([]);
  });

  it("テストファイルと、対象外のフォルダーは検査しない", () => {
    expect(
      checkProjectDataSource("src/shell/labels/X.test.tsx", value),
    ).toEqual([]);
    expect(checkProjectDataSource("src/shell/explorer/X.ts", value)).toEqual(
      [],
    );
  });
});
