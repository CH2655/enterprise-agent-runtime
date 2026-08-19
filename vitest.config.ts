import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function source(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@ear/domain": source("./packages/domain/src/index.ts"),
      "@ear/agent-protocol": source("./packages/agent-protocol/src/index.ts"),
      "@ear/tool-registry": source("./packages/tool-registry/src/index.ts"),
      "@ear/agent-runtime": source("./packages/agent-runtime/src/index.ts"),
      "@ear/auth": source("./packages/auth/src/index.ts"),
      "@ear/persistence": source("./packages/persistence/src/index.ts"),
      "@ear/risk-agent": source("./agents/risk-agent/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    coverage: {
      include: ["packages/**/*.ts", "agents/**/*.ts"],
    },
  },
});
