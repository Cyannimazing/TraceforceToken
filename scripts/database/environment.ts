import { config } from "dotenv";

/** Match Next's local override order without overwriting injected deployment secrets. */
export function loadDatabaseEnvironment(): void {
  config({ path: ".env.local", quiet: true });
  config({ path: ".env", quiet: true });
}
