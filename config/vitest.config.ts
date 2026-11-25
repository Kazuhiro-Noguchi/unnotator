import { defineConfig } from "vitest/config";

// リポジトリのルートから実行する前提。
export default defineConfig({
  test: {
    css: { include: [/\.css\?raw$/] },
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
