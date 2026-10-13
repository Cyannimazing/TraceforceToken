import assert from "node:assert/strict";
import test from "node:test";
import { drizzle } from "drizzle-orm/mysql2";
import type { Connection } from "mysql2/promise";
import * as schema from "../../src/db/schema";
import { createScanAdmissionRepository, InvalidScanClientKeyError, ScanAdmissionUnavailableError, ScanRateLimitError } from "../../src/repositories/scan-admission";

interface Statement { sql: string; values: unknown[] }
/** Checks generated SQL only; genuine concurrency is exercised separately with MariaDB. */
function recordingDatabase(respond: (statement: Statement) => unknown = () => ({ affectedRows: 1 })) {
  const statements: Statement[] = [];
  const driver = { async query(query: { sql: string }, values: unknown[] = []) {
    const statement = { sql: query.sql, values };
    statements.push(statement);
    return [respond(statement), []];
  } };
  const database = drizzle(driver as unknown as Connection, { schema, mode: "default" }) as Parameters<typeof createScanAdmissionRepository>[0];
  return { statements, repository: createScanAdmissionRepository(database) };
}

test("admission-only reservation locks one DB hour and never touches job/evidence/report tables", async () => {
  const key = "a".repeat(64);
  const { repository, statements } = recordingDatabase(({ sql }) => {
    if (sql.includes("TIMESTAMPDIFF(HOUR")) return [[497690, 1234]];
    if (sql.startsWith("select") && sql.includes("scan_admission")) return [[4]];
    return { affectedRows: 1 };
  });
  assert.deepEqual(await repository.reserveScan(key), { retryAfterSeconds: 1234 });
  assert.match(statements[0].sql, /isolation level read committed/i);
  assert.equal(statements[1].sql, "begin");
  assert.match(statements[2].sql, /insert into `investigation_queue_guard`.*on duplicate key update/);
  assert.equal(statements.some(({ sql }) => /investigation_jobs|investigation_evidence|`investigations`/.test(sql)), false);
  const cleanup = statements.find(({ sql }) => sql.startsWith("delete"))!;
  assert.match(cleanup.sql, /expires_at.*DATE_ADD.*limit \?/);
  assert.deepEqual(cleanup.values, [497690, 100]);
  const reservation = statements.find(({ sql }) => sql.startsWith("insert into `investigation_scan_admission`"))!;
  assert.deepEqual(reservation.values, [key, 497690, 1, 497691]);
  assert.match(reservation.sql, /accepted_count.*\+ 1/);
  assert.equal(statements.at(-1)?.sql, "commit");
});

test("sixth reservation rolls back without cleanup, another counter write, or saved work", async () => {
  const { repository, statements } = recordingDatabase(({ sql }) => {
    if (sql.includes("TIMESTAMPDIFF(HOUR")) return [[497690, 43]];
    if (sql.startsWith("select") && sql.includes("scan_admission")) return [[5]];
    return { affectedRows: 1 };
  });
  await assert.rejects(repository.reserveScan("a".repeat(64)), (error: unknown) => error instanceof ScanRateLimitError && error.retryAfterSeconds === 43);
  assert.equal(statements.some(({ sql }) => sql.startsWith("delete") || sql.startsWith("insert into `investigation_scan_admission`")), false);
  assert.equal(statements.at(-1)?.sql, "rollback");
});

test("raw IPs and invalid opaque keys are rejected before any database access", async () => {
  const { repository, statements } = recordingDatabase();
  for (const key of ["", "127.0.0.1", "a".repeat(63), "A".repeat(64), "x".repeat(64)]) await assert.rejects(repository.reserveScan(key), InvalidScanClientKeyError);
  assert.equal(statements.length, 0);
});

test("invalid DB clock or upstream SQL errors fail safely with transaction rollback", async () => {
  for (const mode of ["clock", "driver"] as const) {
    const { repository, statements } = recordingDatabase(({ sql }) => {
      if (sql.includes("TIMESTAMPDIFF(HOUR")) {
        if (mode === "driver") throw new Error("mysql://operator:private-password@private-host/database");
        return [[497690, 0]];
      }
      return { affectedRows: 1 };
    });
    await assert.rejects(repository.reserveScan("a".repeat(64)), (error: unknown) => {
      assert.ok(error instanceof ScanAdmissionUnavailableError);
      assert.doesNotMatch(error.message, /private-password|private-host/);
      return true;
    });
    assert.equal(statements.at(-1)?.sql, "rollback");
  }
});
