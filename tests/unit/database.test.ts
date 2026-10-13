import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { DatabaseConfigurationError, readDatabaseConfig, readDatabaseConnectionConfig } from "../../src/db/config";
import { investigationEvidence, investigations } from "../../src/db/schema";
import { canonicalBaseAddress, canonicalRawAmount, UINT256_MAX } from "../../src/db/values";

const databaseUrl = "mysql://traceforge:p%40ss%3Aword@localhost:3307/traceforge_test";

test("database configuration requires explicit credentials without exposing them", () => {
  assert.throws(() => readDatabaseConfig({}), DatabaseConfigurationError);
  assert.throws(
    () => readDatabaseConfig({ DATABASE_URL: "mysql://private-secret@/bad" }),
    (error: unknown) => error instanceof DatabaseConfigurationError && !error.message.includes("private-secret"),
  );
});

test("runtime and tooling options preserve encoded credentials and bound the pool", () => {
  const config = readDatabaseConfig({ DATABASE_URL: databaseUrl, DATABASE_POOL_SIZE: "3" });
  assert.equal(config.user, "traceforge");
  assert.equal(config.password, "p@ss:word");
  assert.equal(config.port, 3307);
  assert.equal(config.connectionLimit, 3);
  assert.equal(config.multipleStatements, false);
  assert.equal(config.bigNumberStrings, true);
  const connection = readDatabaseConnectionConfig({ DATABASE_URL: databaseUrl });
  assert.equal("connectionLimit" in connection, false);
  assert.equal("queueLimit" in connection, false);
  assert.throws(() => readDatabaseConfig({ DATABASE_URL: databaseUrl, DATABASE_POOL_SIZE: "0" }));
  assert.throws(() => readDatabaseConfig({ DATABASE_URL: databaseUrl, DATABASE_POOL_SIZE: "21" }));
});

test("TLS retains certificate verification and supports a provider CA", () => {
  const config = readDatabaseConfig({
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: "true",
    DATABASE_CA_CERT: "first-line\\nsecond-line",
  });
  assert.deepEqual(config.ssl, { rejectUnauthorized: true, verifyIdentity: true, ca: "first-line\nsecond-line" });
  const remoteUrl = "mysql://traceforge:example-password@database.example.com/traceforge";
  assert.deepEqual(readDatabaseConfig({ DATABASE_URL: remoteUrl }).ssl, {
    rejectUnauthorized: true,
    verifyIdentity: true,
  });
  assert.equal(readDatabaseConfig({ DATABASE_URL: databaseUrl }).ssl, undefined);
  assert.throws(() => readDatabaseConfig({ DATABASE_URL: remoteUrl, DATABASE_SSL: "false" }));
  assert.throws(() => readDatabaseConfig({ DATABASE_URL: "mysql://%20traceforge:example-password@localhost/traceforge" }));
  assert.throws(() => readDatabaseConfig({ DATABASE_URL: "mysql://traceforge:example-password@localhost/trace%20forge" }));
  assert.throws(() => readDatabaseConfig({ DATABASE_URL: databaseUrl, DATABASE_SSL: "invalid" }));
  assert.throws(() => readDatabaseConfig({ DATABASE_URL: databaseUrl, DATABASE_CA_CERT: "a CA", DATABASE_SSL: "false" }));
  assert.throws(() => readDatabaseConfig({ DATABASE_URL: databaseUrl + "?ssl=false" }));
});

test("token identities normalize to lowercase and reject malformed addresses", () => {
  assert.equal(
    canonicalBaseAddress(" 0xAbCd000000000000000000000000000000000000 "),
    "0xabcd000000000000000000000000000000000000",
  );
  assert.throws(() => canonicalBaseAddress("0x1234"));
  assert.throws(() => canonicalBaseAddress("0xgggg000000000000000000000000000000000000"));
});

test("raw amounts retain uint256 precision and reject noncanonical representations", () => {
  assert.equal(canonicalRawAmount(UINT256_MAX.toString()), UINT256_MAX.toString());
  assert.equal(canonicalRawAmount("9007199254740993123456789"), "9007199254740993123456789");
  assert.equal(canonicalRawAmount("0"), "0");
  for (const invalid of ["-1", "01", "1.0", "1e18", " 1", (UINT256_MAX + 1n).toString()]) {
    assert.throws(() => canonicalRawAmount(invalid));
  }
});

test("evidence ownership cascades and source identities are unique per investigation", () => {
  const evidence = getTableConfig(investigationEvidence);
  const ownership = evidence.foreignKeys[0];
  assert.equal(evidence.foreignKeys.length, 1);
  assert.equal(ownership.onDelete, "cascade");
  assert.equal(ownership.reference().foreignTable, investigations);
  const unique = evidence.indexes.find((entry) => entry.config.name === "evidence_investigation_source_uidx");
  assert.equal(unique?.config.unique, true);
  assert.equal(unique?.config.columns.length, 2);
  assert.equal(investigationEvidence.amountRaw.dataType, "string");
  assert.equal(investigationEvidence.blockNumber.dataType, "bigint");
  assert.ok(getTableConfig(investigations).checks.length >= 4);
  assert.ok(evidence.checks.length >= 5);
});
