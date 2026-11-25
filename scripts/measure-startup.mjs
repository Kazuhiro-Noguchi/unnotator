// 起動時間の計測（SC-003、research.md R10）。ビルド済みのアプリを 5 回起動し、中央値と最大値を出す。
// 事前に `pnpm tauri build --no-bundle` でビルドしておく。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RUNS = 5;

export function parseReadyMs(stdout) {
  const match = /UNNOTATOR_READY_MS=(\d+)/.exec(stdout);
  return match ? Number(match[1]) : null;
}

export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[mid]
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return { median, max: sorted[sorted.length - 1], runs: sorted.length };
}

function main() {
  const exe = fileURLToPath(
    new URL(
      `../target/release/unnotator${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  );
  if (!existsSync(exe)) {
    console.error(
      `ビルド済みのアプリが無い: ${exe}\n先に \`pnpm tauri build --no-bundle\` を実行する`,
    );
    process.exit(1);
  }
  const values = [];
  for (let i = 0; i < RUNS; i += 1) {
    const result = spawnSync(exe, [], {
      encoding: "utf8",
      env: { ...process.env, UNNOTATOR_MEASURE_STARTUP: "1" },
      timeout: 60_000,
    });
    const ms = parseReadyMs(result.stdout ?? "");
    if (result.status !== 0 || ms === null) {
      console.error(
        `${i + 1} 回目の起動に失敗した（終了コード ${result.status}）\n${result.stderr ?? ""}`,
      );
      process.exit(1);
    }
    console.log(`${i + 1} 回目: ${ms} ms`);
    values.push(ms);
  }
  const { median, max, runs } = summarize(values);
  console.log(`起動時間（${runs} 回）: 中央値 ${median} ms / 最大 ${max} ms`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
