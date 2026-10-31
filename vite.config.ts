import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r("./apps/web"),
  plugins: [react()],
  resolve: {
    alias: {
      "@richman/shared": r("./packages/shared/src/index.ts"),
      "@richman/game-core": r("./packages/game-core/src/index.ts"),
    },
  },
  build: {
    outDir: r("./apps/web/dist"),
    emptyOutDir: true,
  },
  server: { port: 5173, strictPort: true },
});
