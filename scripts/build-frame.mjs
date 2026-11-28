// 枠の起動用コード（packages/frame-runtime）を 1 ファイルにまとめて、crates/core/src/serve/frame/frame.js に置く。
// `--check` は、置いてある生成物と一致しなければ落ちる（pnpm schema:check から呼ぶ）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = `${root}crates/core/src/serve/frame/frame.js`;

export async function bundle() {
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: {
        entry: `${root}packages/frame-runtime/src/index.ts`,
        formats: ["iife"],
        name: "UnnotatorFrame",
        fileName: () => "frame.js",
      },
      rollupOptions: { output: { codeSplitting: false } },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (r) => r.output,
  );
  const chunk = outputs.find((o) => o.type === "chunk");
  if (chunk === undefined) throw new Error("バンドルの出力が無い");
  return `// 生成物。packages/frame-runtime を scripts/build-frame.mjs でまとめたもの。直接は直さない。\n${chunk.code}`;
}

async function main() {
  const code = await bundle();
  if (process.argv.includes("--check")) {
    const current = existsSync(output) ? readFileSync(output, "utf8") : "";
    if (current !== code) {
      console.error(
        "枠の起動用コードの生成物が古い。`node scripts/build-frame.mjs` で作り直す。",
      );
      process.exit(1);
    }
    console.log("枠の起動用コードの生成物: 問題なし");
    return;
  }
  writeFileSync(output, code);
  console.log(`書き出した: ${output}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
