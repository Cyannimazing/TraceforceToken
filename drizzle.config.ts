import { defineConfig } from "drizzle-kit";
import { loadDatabaseEnvironment } from "./scripts/database/environment";
import { readDatabaseConfig } from "./src/db/config";

loadDatabaseEnvironment();

// Generating/checking committed migrations is an offline operation.
const requiresConnection = process.argv.some((argument) =>
  ["studio", "migrate", "push", "pull"].includes(argument),
);
const connection = process.env.DATABASE_URL || requiresConnection ? readDatabaseConfig() : undefined;

export default defineConfig({
  dialect: "mysql",
  schema: "./src/db/schema.ts",
  out: "./database/migrations",
  strict: true,
  verbose: false,
  ...(connection
    ? {
        dbCredentials: {
          host: connection.host!,
          port: connection.port!,
          user: connection.user!,
          password: connection.password!,
          database: connection.database!,
          ssl: connection.ssl,
        },
      }
    : {}),
});
