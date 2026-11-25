import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// リポジトリのルートから実行する前提。index.html は src/ に置き、出力は tauri.conf.json の frontendDist（dist/）。
export default defineConfig({
  root: "src",
  plugins: [solid()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
});
