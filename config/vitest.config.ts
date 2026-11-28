import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// リポジトリのルートから実行する前提。
// 部品のテスト（`*.test.tsx`）だけが DOM を使う。各ファイルの先頭に `// @vitest-environment happy-dom` と書く。
// ほかのテストは、従来どおり Node で動く。
export default defineConfig({
  plugins: [solid()],
  resolve: { conditions: ["development", "browser"] },
  test: {
    // vite-plugin-solid は既定を jsdom にする。使うのは happy-dom で、既定は Node のまま
    environment: "node",
    css: { include: [/\.css\?raw$/] },
    include: [
      "src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.mjs",
      "packages/frame-runtime/tests/**/*.test.ts",
    ],
  },
});
