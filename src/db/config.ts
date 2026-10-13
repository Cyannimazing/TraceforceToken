import type { ConnectionOptions, PoolOptions } from "mysql2/promise";

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

export type DatabaseEnvironment = Record<string, string | undefined>;

/** Shared by the application, migration runner, and Drizzle Studio. */
export function readDatabaseConfig(
  environment: DatabaseEnvironment = process.env,
): PoolOptions {
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new DatabaseConfigurationError(
      "DATABASE_URL is required for database operations. Configure a MySQL connection in .env.local or the deployment environment.",
    );
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new DatabaseConfigurationError("DATABASE_URL must be a valid mysql:// connection URL.");
  }

  if (url.protocol !== "mysql:" || !url.hostname || !url.username) {
    throw new DatabaseConfigurationError(
      "DATABASE_URL must use mysql:// and include a host, user, and database name.",
    );
  }
  if (url.search || url.hash) {
    throw new DatabaseConfigurationError(
      "DATABASE_URL must not contain query parameters or a fragment. Configure TLS with DATABASE_SSL and DATABASE_CA_CERT.",
    );
  }

  let user: string;
  let password: string;
  let database: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new DatabaseConfigurationError("DATABASE_URL contains an invalid percent-encoded value.");
  }
  if (!database || database.includes("/") || !user || /[\s\0]/.test(user) || /[\s\0]/.test(database)) {
    throw new DatabaseConfigurationError("DATABASE_URL must identify exactly one database.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";

  const sslSetting = environment.DATABASE_SSL?.trim().toLowerCase();
  if (sslSetting && sslSetting !== "true" && sslSetting !== "false") {
    throw new DatabaseConfigurationError("DATABASE_SSL must be true or false.");
  }
  const useTls = sslSetting ? sslSetting === "true" : !isLocalHost;
  if (!isLocalHost && !useTls) {
    throw new DatabaseConfigurationError(
      "Remote database connections require verified TLS. Set DATABASE_SSL=true or connect through a local secure tunnel.",
    );
  }
  const ca = environment.DATABASE_CA_CERT?.replace(/\\n/g, "\n").trim();
  if (ca && !useTls) {
    throw new DatabaseConfigurationError("DATABASE_CA_CERT requires DATABASE_SSL=true.");
  }

  const poolSize = Number(environment.DATABASE_POOL_SIZE || "5");
  if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 20) {
    throw new DatabaseConfigurationError("DATABASE_POOL_SIZE must be an integer between 1 and 20.");
  }

  return {
    host,
    port: url.port ? Number(url.port) : 3306,
    user,
    password,
    database,
    ssl: useTls ? { rejectUnauthorized: true, verifyIdentity: true, ...(ca ? { ca } : {}) } : undefined,
    connectionLimit: poolSize,
    maxIdle: poolSize,
    idleTimeout: 10_000,
    waitForConnections: true,
    queueLimit: 25,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    charset: "utf8mb4",
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  };
}

/** The migration runner uses one connection, so omit pool-only driver options. */
export function readDatabaseConnectionConfig(
  environment: DatabaseEnvironment = process.env,
): ConnectionOptions {
  const options = readDatabaseConfig(environment);
  delete options.connectionLimit;
  delete options.maxIdle;
  delete options.idleTimeout;
  delete options.waitForConnections;
  delete options.queueLimit;
  return options;
}
