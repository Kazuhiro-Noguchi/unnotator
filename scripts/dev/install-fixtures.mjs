// 009 のテスト用の拡張機能（scripts/spikes/s02/ext-*）を、アプリのデータ置き場へ置き、サンプルのプロジェクトを作る。
// macOS・Windows・Linux 共通（Node だけで動く）。`pnpm tauri dev` を起動する前に実行する。
// 使い方: node scripts/dev/install-fixtures.mjs [--dry-run] [--project <フォルダ>]

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const IDENTIFIER = "app.unnotator.desktop";
const root = fileURLToPath(new URL("../..", import.meta.url));
const dryRun = process.argv.includes("--dry-run");
const projectArg = process.argv.indexOf("--project");
const project =
  projectArg >= 0 ? process.argv[projectArg + 1] : join(tmpdir(), "unno-009");

/** Tauri の app_data_dir（ポータブル版でない場合）。 */
export function dataDir(platform = process.platform, env = process.env) {
  if (platform === "darwin")
    return join(homedir(), "Library", "Application Support", IDENTIFIER);
  if (platform === "win32")
    return join(
      env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      IDENTIFIER,
    );
  return join(
    env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    IDENTIFIER,
  );
}

const EXTENSIONS = ["base", "rect", "writer", "bad"];

function main() {
  const target = join(dataDir(), "extensions");
  console.log(`置き場: ${target}`);
  for (const name of EXTENSIONS) {
    const from = join(root, "scripts", "spikes", "s02", `ext-${name}`);
    const to = join(target, `dev.spike.${name}`, "0.0.1");
    if (!existsSync(from)) throw new Error(`見つからない: ${from}`);
    console.log(`  ${from} -> ${to}`);
    if (dryRun) continue;
    rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  console.log(`サンプルのプロジェクト: ${project}`);
  if (!dryRun) {
    const r = spawnSync(
      process.execPath,
      [
        join(root, "scripts", "make-sample-project.mjs"),
        "--out",
        project,
        "--assets",
        "100",
      ],
      { stdio: "inherit" },
    );
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  console.log(
    dryRun ? "（--dry-run: 何も書いていない）" : "済んだ。次: pnpm tauri dev",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
