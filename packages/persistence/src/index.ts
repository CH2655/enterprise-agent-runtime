import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema.js";

export * from "./schema.js";
export * from "./repositories.js";

export type AgentDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseConnection {
  db: AgentDatabase;
  pool: Pool;
  close(): Promise<void>;
}

export function createDatabaseConnection(connectionString: string): DatabaseConnection {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

export async function migrateDatabase(
  db: AgentDatabase,
  migrationsFolder: string,
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
