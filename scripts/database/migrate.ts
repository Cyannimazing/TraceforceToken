import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { DatabaseConfigurationError, readDatabaseConnectionConfig } from "../../src/db/config";
import { loadDatabaseEnvironment } from "./environment";

class MigrationLockError extends Error {}

interface LockResult extends RowDataPacket {
  acquired: number | null;
}

async function main(): Promise<void> {
  loadDatabaseEnvironment();
  const testMode = process.argv.includes("--test");
  const connectionUrl = testMode
    ? process.env.TEST_DATABASE_URL
    : process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (testMode && !connectionUrl) {
    throw new DatabaseConfigurationError("TEST_DATABASE_URL is required for --test migration mode. No database was selected.");
  }
  // A dedicated connection keeps migration execution independent of app pools.
  const options = readDatabaseConnectionConfig({
    ...process.env,
    DATABASE_URL: connectionUrl,
    DATABASE_SSL: testMode ? process.env.TEST_DATABASE_SSL ?? "false" : process.env.DATABASE_SSL,
    DATABASE_CA_CERT: testMode ? process.env.TEST_DATABASE_CA_CERT : process.env.DATABASE_CA_CERT,
  });
  if (testMode && (!["localhost", "127.0.0.1", "::1"].includes(options.host!) || !options.database?.startsWith("traceforge_test_"))) {
    throw new DatabaseConfigurationError("Test migrations require a local disposable database named traceforge_test_*.");
  }
  const connection = await createConnection(options);
  // Server-wide names must be <= 64 characters and unique to this database.
  const databaseIdentity = createHash("sha256").update(options.database!.toLowerCase()).digest("hex").slice(0, 40);
  const lockName = `traceforge:migrate:${databaseIdentity}`;
  let lockAcquired = false;
  try {
    const [rows] = await connection.execute<LockResult[]>(
      "SELECT GET_LOCK(?, ?) AS acquired",
      [lockName, 30],
    );
    if (rows[0]?.acquired !== 1) {
      throw new MigrationLockError(
        "Could not acquire the Traceforge migration lock. Another migration may be running or the host may not support advisory locks. No migration SQL was applied by this attempt.",
      );
    }
    lockAcquired = true;
    console.info("Applying committed Traceforge database migrations...");
    await migrate(drizzle(connection), { migrationsFolder: "./database/migrations" });
  } finally {
    try {
      if (lockAcquired) {
        await connection.execute("SELECT RELEASE_LOCK(?)", [lockName]);
      }
    } catch {
      // Closing this dedicated session releases its advisory lock on the server.
      console.warn("Could not explicitly release the migration lock; closing the dedicated database connection.");
    } finally {
      await connection.end();
    }
  }
  console.info("Database migrations applied.");
}

main().catch((error: unknown) => {
  console.error(
    error instanceof DatabaseConfigurationError || error instanceof MigrationLockError
      ? error.message
      : "Database migration failed. Check database reachability, verified TLS, credentials, advisory-lock support, and migration permissions. Connection details were not logged.",
  );
  process.exitCode = 1;
});
