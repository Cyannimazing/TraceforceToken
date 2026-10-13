import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "dotenv";
import { createConnection } from "mysql2/promise";

const port = Number(process.env.LOCAL_MYSQL_PORT ?? "3306");
const host = "127.0.0.1";
const envPath = ".env.local";
const specifications = [
  { key: "DATABASE_URL", database: "traceforge_local", user: "traceforge_local", permissions: "SELECT, INSERT, UPDATE, DELETE" },
  { key: "DATABASE_MIGRATION_URL", database: "traceforge_local", user: "traceforge_migrate_local", permissions: "ALL PRIVILEGES" },
  { key: "TEST_DATABASE_URL", database: "traceforge_test_jobs", user: "traceforge_test", permissions: "ALL PRIVILEGES" },
] as const;

async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local port.");
  let contents = "";
  try { contents = await readFile(envPath, "utf8"); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
  const existing = parse(contents);
  const credentials = specifications.map((specification) => {
    const url = existing[specification.key] ? new URL(existing[specification.key]) : null;
    if (url && (url.protocol !== "mysql:" || url.hostname !== host || url.pathname !== `/${specification.database}` || decodeURIComponent(url.username) !== specification.user || Number(url.port || 3306) !== port)) {
      throw new Error("Existing database configuration is outside this local setup's scope.");
    }
    return { ...specification, password: url ? decodeURIComponent(url.password) : randomBytes(32).toString("hex") };
  });
  const connection = await createConnection({ host, port, user: process.env.LOCAL_MYSQL_ADMIN_USER || "root", password: process.env.LOCAL_MYSQL_ADMIN_PASSWORD || "", connectTimeout: 5000, multipleStatements: false });
  try {
    const [version] = await connection.query("SELECT VERSION() AS version");
    console.info("Connected to local XAMPP MySQL/MariaDB.");
    console.info(JSON.stringify(version));
    for (const database of new Set(credentials.map((entry) => entry.database))) {
      // Identifiers come only from the fixed application-owned specifications above.
      await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    }
    for (const credential of credentials) {
      await connection.query("CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?", [credential.user, host, credential.password]);
      await connection.query(`GRANT ${credential.permissions} ON \`${credential.database}\`.* TO ?@?`, [credential.user, host]);
      const probe = await createConnection({ host, port, user: credential.user, password: credential.password, database: credential.database, connectTimeout: 5000 });
      await probe.end();
    }
  } finally { await connection.end(); }
  const settings: Record<string, string> = {
    SITE_URL: existing.SITE_URL || "http://localhost:3000", ALLOW_INDEXING: "false", DATABASE_SSL: "false", DATABASE_POOL_SIZE: "5",
    RATE_LIMIT_SECRET: existing.RATE_LIMIT_SECRET || randomBytes(32).toString("hex"),
    CRON_SECRET: existing.CRON_SECRET || randomBytes(32).toString("hex"),
    BASE_RPC_URL: existing.BASE_RPC_URL || "https://base.drpc.org",
    BASE_RPC_LOG_CHUNK_SIZE: existing.BASE_RPC_LOG_CHUNK_SIZE || "10",
    BASE_MAX_TRANSFER_LOGS: existing.BASE_MAX_TRANSFER_LOGS || "100",
    LOCAL_AI_BASE_URL: existing.LOCAL_AI_BASE_URL || "http://127.0.0.1:11434",
    LOCAL_AI_MODEL: existing.LOCAL_AI_MODEL || "traceforce-investigator",
  };
  contents = contents.replace(/^TRACEFORGE_(?:ACCESS_KEY|SESSION_SECRET)=.*\r?\n?/gm, "");
  for (const credential of credentials) settings[credential.key] = `mysql://${credential.user}:${encodeURIComponent(credential.password)}@${host}:${port}/${credential.database}`;
  for (const [key, value] of Object.entries(settings)) {
    const line = `${key}=${JSON.stringify(value)}`;
    const expression = new RegExp(`^${key}=.*$`, "m");
    contents = expression.test(contents) ? contents.replace(expression, () => line) : `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  await writeFile(envPath, contents, { mode: 0o600 });
  console.info("Created local application/test databases and scoped accounts. Configuration saved to ignored .env.local; no credentials were printed.");
  console.info("Next: apply the application and disposable-test migrations explicitly. Public scans need no sign-in or wallet connection.");
}

main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "LOCAL_SETUP_FAILED";
  console.error(`Local database setup failed (${/^[A-Z0-9_]+$/.test(code) ? code : "LOCAL_SETUP_FAILED"}). Check XAMPP MySQL, local port, admin credentials, or existing local configuration. Credentials were not logged.`);
  process.exitCode = 1;
});
