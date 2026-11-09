import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@richman/shared": r("./packages/shared/src/index.ts"),
      "@richman/game-core": r("./packages/game-core/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/tests/**/*.test.ts", "apps/*/tests/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
