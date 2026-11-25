import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    css: { include: [/\.css\?raw$/] },
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
