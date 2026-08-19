import { defineConfig } from "drizzle-kit";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://ear:ear_dev@127.0.0.1:5434/ear";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/persistence/src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
