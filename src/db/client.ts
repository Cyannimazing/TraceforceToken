import "server-only";

import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2";
import { readDatabaseConfig } from "./config";
import * as schema from "./schema";

function createDatabaseClient() {
  const pool = createPool(readDatabaseConfig());
  // Vercel Fluid compute can release idle connections when an instance suspends.
  attachDatabasePool(pool);
  const database = drizzle(pool.promise(), { schema, mode: "default" });
  return { pool, database };
}

type DatabaseClient = ReturnType<typeof createDatabaseClient>;

const databaseGlobal = globalThis as typeof globalThis & {
  traceforgeDatabaseClient?: DatabaseClient;
};

/** Lazy initialization lets the Next.js foundation build without database secrets. */
export function getDatabase() {
  databaseGlobal.traceforgeDatabaseClient ??= createDatabaseClient();
  return databaseGlobal.traceforgeDatabaseClient.database;
}

/** Exposed for explicit server lifecycle handling; normal queries use getDatabase(). */
export function getDatabasePool(): Pool {
  getDatabase();
  return databaseGlobal.traceforgeDatabaseClient!.pool;
}
