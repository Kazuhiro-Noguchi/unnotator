import { appendFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// リポジトリのルートから実行する前提。index.html は src/ に置き、出力は tauri.conf.json の frontendDist（dist/）。
export default defineConfig({
  root: "src",
  plugins: [
    solid(),
    // S-02 検証用（一時）。WebView から HMR の WebSocket で結果を受け取り、ファイルに書く。
    {
      name: "s02-report",
      configureServer(server) {
        server.ws.on("s02:report", (data: string) => {
          writeFileSync(process.env.S02_OUT ?? "/tmp/s02.txt", data);
        });
      },
    },
    // 開発時だけ、画面のエラーと console を、ファイルに書く（`src/shell/dev/console-forward.ts` が送る）。
    {
      name: "dev-console",
      configureServer(server) {
        const file =
          process.env.UNNO_DEV_CONSOLE ?? "/tmp/unnotator-console.log";
        server.ws.on("dev:log", (line: string) => {
          appendFileSync(file, `${line}\n`);
        });
      },
    },
  ],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
});
