// 依存の向きの検査（FR-004、research.md R7）。`pnpm lint` から呼ぶ。
//  1. ワークスペース内の依存の辺は許可した組み合わせだけ。
//  2. `crates/*` の推移的な依存に `tauri` で始まる名前のクレートが無い。
//  3. 各クレートの Cargo.toml が外部の依存の版を直接書いていない（版はルートの [workspace.dependencies] だけ）。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_EDGES = new Set([
  "unnotator -> unnotator-core",
  "unnotator -> unnotator-extensions",
  "unnotator -> unnotator-worker",
  "unnotator-worker -> unnotator-extensions",
  "unnotator-worker -> unnotator-core",
  "unnotator-extensions -> unnotator-core",
]);

/** `cargo metadata --format-version 1 --no-deps` ではなく、依存先の情報を含む出力を受け取る。 */
export function checkMetadata(metadata) {
  const problems = [];
  const byName = new Map(metadata.packages.map((p) => [p.name, p]));
  const members = metadata.packages.filter((p) =>
    metadata.workspace_members.includes(p.id),
  );
  const memberNames = new Set(members.map((p) => p.name));

  for (const member of members) {
    for (const dep of member.dependencies) {
      if (
        memberNames.has(dep.name) &&
        !ALLOWED_EDGES.has(`${member.name} -> ${dep.name}`)
      ) {
        problems.push(`許可されない依存: ${member.name} -> ${dep.name}`);
      }
    }
  }

  for (const member of members.filter((p) =>
    p.manifest_path.includes("/crates/"),
  )) {
    const seen = new Set();
    const stack = [member.name];
    while (stack.length > 0) {
      const name = stack.pop();
      if (name === undefined || seen.has(name)) continue;
      seen.add(name);
      if (name !== member.name && name.startsWith("tauri")) {
        problems.push(
          `${member.name} が tauri 系のクレートに依存している: ${name}`,
        );
      }
      for (const dep of byName.get(name)?.dependencies ?? [])
        stack.push(dep.name);
    }
  }
  return problems;
}

/** Cargo.toml の依存の節を走査し、`workspace = true` でも `path` でもない依存を報告する。 */
export function checkDirectVersions(file, toml) {
  const problems = [];
  let inDeps = false;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inDeps = /^\[(dev-|build-)?dependencies\]$/.test(line);
      continue;
    }
    if (!inDeps || line === "" || line.startsWith("#")) continue;
    const name = line.split(/[\s=.]/)[0];
    const viaWorkspace = /workspace\s*=\s*true/.test(line);
    const viaPath = /\bpath\s*=/.test(line);
    if (!viaWorkspace && !viaPath) {
      problems.push(
        `${file}: ${name} の版を直接書いている（ルートの [workspace.dependencies] に書く）`,
      );
    }
  }
  return problems;
}

/**
 * 汎用プレビュー（`src/preview/`）は表示専用で、プロジェクトのデータを読み書きしない（憲章 I・III）。
 * `ipc` から値（`commands` など）を import できるのは `external.ts` だけで、そこで呼べるのは
 * `openInDefaultApp`（OS の既定のアプリで開く）だけ。型の import はどこでもよい。テストは検査しない。
 */
export function checkPreviewSource(file, source) {
  if (/\.test\.(ts|tsx)$/.test(file)) return [];
  const problems = [];
  const isExternal = file.endsWith("/external.ts");
  const importPattern =
    /import\s+(type\s+)?[^;]*?from\s+["']((?:\.\.?\/)+ipc(?:\/[^"']*)?)["']/gs;
  for (const match of source.matchAll(importPattern)) {
    const isType = Boolean(match[1]);
    if (!isType && !isExternal) {
      problems.push(
        `${file}: プレビューは ipc から値を import できない（external.ts だけが、既定のアプリで開く呼び出しに使う）`,
      );
    }
  }
  if (isExternal) {
    for (const call of source.matchAll(/commands\.(\w+)/g)) {
      if (call[1] !== "openInDefaultApp") {
        problems.push(
          `${file}: プレビューが呼べる IPC は openInDefaultApp だけ（commands.${call[1]}）`,
        );
      }
    }
  } else {
    for (const call of source.matchAll(/commands\.(\w+)/g)) {
      problems.push(
        `${file}: プレビューは IPC を呼べない（commands.${call[1]}）`,
      );
    }
  }
  return problems;
}

/**
 * 008: ラベル・プロパティ・スキーマの画面（`src/shell/{labels,properties,schema}/`）は、
 * `ipc` から値（`commands` など）を直接 import しない。読み書きは `src/shell/project-data/` を通す。型の import は許す。
 */
export function checkProjectDataSource(file, source) {
  if (/\.test\.(ts|tsx)$/.test(file)) return [];
  if (!/^src\/shell\/(labels|properties|schema)\//.test(file)) return [];
  const problems = [];
  const importPattern =
    /import\s+(type\s+)?[^;]*?from\s+["']((?:\.\.?\/)+ipc(?:\/[^"']*)?)["']/gs;
  for (const match of source.matchAll(importPattern)) {
    if (!match[1]) {
      problems.push(
        `${file}: 画面は ipc から値を import できない（src/shell/project-data/ を通す）`,
      );
    }
  }
  return problems;
}

/** 009: 枠の中の起動用コード（`packages/frame-runtime/`）は、本体の TS（`src/`）に依存しない。 */
export function checkFrameRuntimeSource(file, source) {
  if (!file.startsWith("packages/frame-runtime/")) return [];
  const problems = [];
  const importPattern = /from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const spec = match[1] ?? "";
    if (!spec.startsWith(".")) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(file), spec));
    const inside = resolved.startsWith("packages/frame-runtime/");
    const toCrates = resolved.startsWith(
      "crates/extensions/host-api-permissions",
    );
    if (!inside && !toCrates) {
      problems.push(
        `${file}: 枠の起動用コードは本体の TS を import できない（${spec}）`,
      );
    }
  }
  return problems;
}

function walkSource(root, rel, check) {
  const problems = [];
  const dir = `${root}${rel}`;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = `${d}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        problems.push(
          ...check(path.slice(root.length), readFileSync(path, "utf8")),
        );
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return problems;
}

function checkPreviewDir() {
  const problems = [];
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = `${root}src/preview`;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = `${d}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        problems.push(
          ...checkPreviewSource(
            path.slice(root.length),
            readFileSync(path, "utf8"),
          ),
        );
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return problems;
}

function main() {
  const result = spawnSync("cargo", ["metadata", "--format-version", "1"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(`cargo metadata が失敗した: ${result.stderr}`);
    process.exit(1);
  }
  const metadata = JSON.parse(result.stdout);
  const problems = [
    ...checkMetadata(metadata),
    ...checkPreviewDir(),
    ...walkSource(
      fileURLToPath(new URL("..", import.meta.url)),
      "src/shell",
      checkProjectDataSource,
    ),
    ...walkSource(
      fileURLToPath(new URL("..", import.meta.url)),
      "packages/frame-runtime",
      checkFrameRuntimeSource,
    ),
  ];
  for (const p of metadata.packages.filter((p) =>
    metadata.workspace_members.includes(p.id),
  )) {
    problems.push(
      ...checkDirectVersions(
        p.manifest_path,
        readFileSync(p.manifest_path, "utf8"),
      ),
    );
  }
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log("依存の向きの検査: 問題なし");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
