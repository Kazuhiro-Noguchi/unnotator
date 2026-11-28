// 拡張機能ホストの性能を測り、結果を specs/009-extension-host/perf.md に書く（T068）。
// 使い方: node scripts/measure-extension-host.mjs
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}specs/009-extension-host/perf.md`;
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "--config",
    "config/vitest.config.ts",
    "src/host/perf.test.ts",
  ],
  {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, PERF_OUT: out },
  },
);
console.log(`記録した: ${out}`);
process.exit(result.status ?? 1);
