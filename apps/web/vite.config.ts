import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@ear/rn-agent-sdk": fileURLToPath(new URL("../../packages/rn-agent-sdk/src/index.ts", import.meta.url)),
      "@ear/agent-protocol": fileURLToPath(new URL("../../packages/agent-protocol/src/index.ts", import.meta.url)),
      "@ear/domain": fileURLToPath(new URL("../../packages/domain/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
