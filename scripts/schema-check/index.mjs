// 契約の検査の実行役。工程を登録して順に実行し、失敗しても残りを続け、最後にまとめて結果を出す。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** コマンドを実行し、失敗したら例外を投げる。出力はそのまま表示する。 */
function sh(command, args) {
  return () => {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} が終了コード ${result.status} で失敗した`,
      );
    }
  };
}

/** 登録する工程。`{ name, run }`。`run` は失敗したら例外を投げる。 */
export const steps = [
  {
    name: "DB スキーマの適用",
    run: sh("cargo", ["test", "-p", "unnotator-core", "--test", "contracts"]),
  },
  {
    name: "マニフェストの見本",
    run: sh("node", ["scripts/schema-check/manifests.mjs"]),
  },
  {
    name: "ワーカープロトコルの型検査",
    run: sh("pnpm", ["exec", "tsc", "-p", "crates/worker"]),
  },
  {
    name: "拡張 API の型検査",
    run: sh("pnpm", ["exec", "tsc", "-p", "packages/plugin-api"]),
  },
  {
    name: "拡張 API のパッケージ",
    run: sh("node", ["scripts/schema-check/plugin-api-pack.mjs"]),
  },
];

/** 前提が欠けていれば、足りないものを名指しした文のリストを返す。 */
export function checkPrerequisites({ hasCommand, exists }) {
  const missing = [];
  if (!hasCommand("cargo")) {
    missing.push(
      "cargo が見つからない（rustup で Rust を入れる。rust-toolchain.toml が版を決める）",
    );
  }
  if (!exists("node_modules")) {
    missing.push(
      "node_modules が無い（`corepack enable` のあと `pnpm install` を実行する）",
    );
  }
  return missing;
}

/** 工程を順に実行する。1 つが失敗しても残りを続ける。 */
export async function runSteps(list, log) {
  const failed = [];
  for (const step of list) {
    log(`== ${step.name}`);
    try {
      await step.run();
      log(`   OK: ${step.name}`);
    } catch (error) {
      failed.push(step.name);
      const message = error instanceof Error ? error.message : String(error);
      log(`   NG: ${step.name}: ${message}`);
    }
  }
  log(
    failed.length === 0
      ? `すべての工程が成功した（${list.length} 件）`
      : `失敗した工程: ${failed.join(", ")}（${failed.length}/${list.length} 件）`,
  );
  return { failed, exitCode: failed.length === 0 ? 0 : 1 };
}

function hasCommand(name) {
  return spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;
}

async function main() {
  const missing = checkPrerequisites({ hasCommand, exists: existsSync });
  if (missing.length > 0) {
    for (const item of missing) console.error(`前提が足りない: ${item}`);
    process.exit(1);
  }
  const { exitCode } = await runSteps(steps, console.log);
  process.exit(exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
