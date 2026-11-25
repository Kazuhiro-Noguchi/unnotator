// `@unnotator/plugin-api` を固めて、利用者の目線で使えることを確かめる（FR-018・FR-019、research.md R6）。
//  1. pnpm pack で固める。  2. 一時ディレクトリに展開し、files が揃うことを確かめる。
//  3. 利用側の見本を、展開したパッケージに向けて型検査する。  4. 版数と API_VERSION を照合する。
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Windows では、pnpm は `.cmd` のため、シェル経由でないと起動できない
const SHELL = process.platform === "win32";

const REQUIRED_FILES = ["index.d.ts", "LICENSE", "README.md", "package.json"];

export function apiVersionOf(dts) {
  return /API_VERSION\s*:\s*['"]([^'"]+)['"]/.exec(dts)?.[1] ?? null;
}

export function checkVersion(packageVersion, apiVersion) {
  return packageVersion === apiVersion
    ? []
    : [
        `package.json の版数 ${packageVersion} が API_VERSION ${apiVersion} と一致しない`,
      ];
}

/** 展開したファイルの一覧（`package/` 付き）から、足りないものを返す。 */
export function missingFiles(listed) {
  return REQUIRED_FILES.filter((f) => !listed.includes(`package/${f}`));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: command === "pnpm" && SHELL,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} が失敗した\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout;
}

function main() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const pkgDir = join(root, "packages/plugin-api");
  const work = mkdtempSync(join(tmpdir(), "unnotator-plugin-api-"));
  const problems = [];
  try {
    run("pnpm", ["pack", "--pack-destination", work], { cwd: pkgDir });
    const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
    if (tgz === undefined) throw new Error("tgz が作られなかった");

    const extractDir = join(work, "extract");
    mkdirSync(extractDir);
    run("tar", ["-xzf", join(work, tgz), "-C", extractDir]);
    const listed = run("tar", ["-tzf", join(work, tgz)])
      .split(/\r?\n/)
      .filter(Boolean);
    for (const name of missingFiles(listed))
      problems.push(`固めたパッケージに ${name} が無い`);

    const missing = missingFiles(listed);
    if (missing.length === 0) {
      // 利用側の見本を、展開したパッケージ（node_modules/@unnotator/plugin-api）に向けて型検査する。
      const consumer = join(work, "consumer");
      cpSync(join(pkgDir, "test/consumer"), consumer, { recursive: true });
      const installed = join(consumer, "node_modules/@unnotator/plugin-api");
      mkdirSync(installed, { recursive: true });
      cpSync(join(extractDir, "package"), installed, { recursive: true });
      const tsc = spawnSync("pnpm", ["exec", "tsc", "-p", consumer], {
        cwd: root,
        encoding: "utf8",
        shell: SHELL,
      });
      if (tsc.status !== 0)
        problems.push(`利用側の型検査が失敗した\n${tsc.stdout}${tsc.stderr}`);

      const packageVersion = JSON.parse(
        readFileSync(join(extractDir, "package/package.json"), "utf8"),
      ).version;
      const apiVersion = apiVersionOf(
        readFileSync(join(extractDir, "package/index.d.ts"), "utf8"),
      );
      problems.push(...checkVersion(packageVersion, apiVersion));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log("plugin-api のパッケージ: 問題なし");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
