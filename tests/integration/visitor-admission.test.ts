import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { count, eq, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";
import { readDatabaseConfig } from "../../src/db/config";
import { loadDatabaseEnvironment } from "../../scripts/database/environment";
import * as schema from "../../src/db/schema";
import {
  createVisitorAdmissionRepository, VisitorRateLimitError, VisitorScanActiveError,
} from "../../src/repositories/visitor-admission";

loadDatabaseEnvironment();
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for genuine visitor admission integration tests. No migrations were applied.");
const configuration = readDatabaseConfig({
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  DATABASE_SSL: process.env.TEST_DATABASE_SSL ?? "false",
  DATABASE_CA_CERT: process.env.TEST_DATABASE_CA_CERT,
  DATABASE_POOL_SIZE: "10",
});
if (!["localhost", "127.0.0.1", "::1"].includes(configuration.host!) || !configuration.database?.startsWith("traceforge_test_")) {
  throw new Error("Visitor admission tests require a local disposable traceforge_test_* database. Only its visitor admission table is reset.");
}

describe("genuine MySQL/MariaDB per-visitor burst and scan leases", { concurrency: false }, () => {
  let pool: Pool;
  let database: NonNullable<Parameters<typeof createVisitorAdmissionRepository>[0]>;
  let repository: ReturnType<typeof createVisitorAdmissionRepository>;
  let ready = false;
  const key = "a".repeat(64);
  const otherKey = "b".repeat(64);

  before(async () => {
    // Permit this fixture's70 simultaneous transactions to reach MariaDB rather
    // than fail at the runtime pool's intentionally smaller waiting-queue bound.
    pool = createPool({ ...configuration, queueLimit: 100 });
    database = drizzle(pool, { schema, mode: "default" });
    repository = createVisitorAdmissionRepository(database);
    try {
      // Read-only prerequisite. Schema application is an explicit operator action.
      await database.select().from(schema.visitorAdmission).limit(1);
      ready = true;
    } catch {
      throw new Error("The disposable database is unavailable or the visitor admission migration is missing. No migration was automatically applied.");
    }
  });
  beforeEach(async () => { await database.delete(schema.visitorAdmission); });
  after(async () => {
    if (ready) await database.delete(schema.visitorAdmission);
    if (pool) await pool.end();
  });

  const stored = async (visitorKey = key) => {
    const [row] = await database.select().from(schema.visitorAdmission).where(eq(schema.visitorAdmission.visitorKey, visitorKey));
    return row;
  };
  const clock = async () => {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000 AS milliseconds");
    return Number(rows[0].milliseconds);
  };

  test("40 simultaneous requests admit exactly30 for one visitor and store no request content", async () => {
    const results = await Promise.allSettled(Array.from({ length: 40 }, () => repository.consumeRequest(key)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 30);
    const rejections = results.filter((result) => result.status === "rejected");
    assert.equal(rejections.length, 10);
    for (const result of rejections) {
      assert.ok(result.reason instanceof VisitorRateLimitError);
      assert.ok(result.reason.retryAfterSeconds >= 1 && result.reason.retryAfterSeconds <= 30);
    }
    const row = await stored();
    assert.equal(row.requestCount, 30);
    assert.equal(row.leaseToken, null);
    assert.equal(row.leaseExpiresAt, null);
    assert.deepEqual(Object.keys(row).sort(), ["expiresAt", "leaseExpiresAt", "leaseToken", "requestCount", "visitorKey", "windowStartedAt"].sort());
  });

  test("independent visitors each receive30 requests rather than sharing a local bucket", async () => {
    const [first, second] = await Promise.all([key, otherKey].map(async (visitorKey) => {
      const results = await Promise.allSettled(Array.from({ length: 35 }, () => repository.consumeRequest(visitorKey)));
      return results.filter((result) => result.status === "fulfilled").length;
    }));
    assert.equal(first, 30);
    assert.equal(second, 30);
    assert.equal((await stored(key)).requestCount, 30);
    assert.equal((await stored(otherKey)).requestCount, 30);
  });

  test("one simultaneous scan wins per visitor; another visitor can scan independently", async () => {
    await repository.consumeRequest(key);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => repository.acquireScan(key)));
    const winners = results.filter((result) => result.status === "fulfilled");
    assert.equal(winners.length, 1);
    for (const result of results.filter((entry) => entry.status === "rejected")) assert.ok(result.reason instanceof VisitorScanActiveError);
    const second = await repository.acquireScan(otherKey);
    assert.equal((await stored(key)).requestCount, 1, "lease acquisition must not spend another burst request");
    assert.equal((await stored(otherKey)).requestCount, 0);
    const first = winners[0].value;
    await first.release();
    await first.release();
    assert.equal((await stored(key)).leaseToken, null);
    assert.equal((await stored(otherKey)).leaseToken, second.token);
    await second.release();
  });

  test("a stale release token cannot clear an expired lease's replacement", async () => {
    const oldLease = await repository.acquireScan(key);
    await database.update(schema.visitorAdmission).set({
      leaseExpiresAt: sql`DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND)`,
    }).where(eq(schema.visitorAdmission.visitorKey, key));
    const replacement = await repository.acquireScan(key);
    assert.notEqual(oldLease.token, replacement.token);
    await oldLease.release();
    assert.equal((await stored()).leaseToken, replacement.token);
    await assert.rejects(repository.acquireScan(key), VisitorScanActiveError);
    await replacement.release();
    await replacement.release();
    const next = await repository.acquireScan(key);
    assert.notEqual(next.token, replacement.token);
    await next.release();
  });

  test("a new visitor window resets an exhausted burst while preserving its still-live lease", async () => {
    const lease = await repository.acquireScan(key);
    const initial = await stored();
    await database.update(schema.visitorAdmission).set({
      windowStartedAt: sql`DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 31 SECOND)`, requestCount: 30,
    }).where(eq(schema.visitorAdmission.visitorKey, key));
    const beforeReset = await clock();
    const response = await repository.consumeRequest(key);
    const row = await stored();
    assert.equal(row.requestCount, 1);
    assert.ok(row.windowStartedAt.getTime() >= beforeReset);
    assert.ok(response.retryAfterSeconds >= 29 && response.retryAfterSeconds <= 30);
    assert.equal(row.leaseToken, lease.token);
    assert.equal(row.leaseExpiresAt?.getTime(), initial.leaseExpiresAt?.getTime());
    assert.equal(row.expiresAt.getTime(), initial.expiresAt.getTime());
    await assert.rejects(repository.acquireScan(key), VisitorScanActiveError);
    await lease.release();
  });

  test("cleanup deletes at most20 expired visitors, including stale leases, and keeps live leases", async () => {
    const expired = Array.from({ length: 26 }, (_, index) => ({
      visitorKey: index.toString(16).padStart(64, "0"),
      windowStartedAt: sql`DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 60 SECOND)`, requestCount: 30,
      leaseToken: index === 0 ? randomUUID() : null,
      leaseExpiresAt: index === 0 ? sql`DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 SECOND)` : null,
      expiresAt: sql`DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 SECOND)`,
    }));
    await database.insert(schema.visitorAdmission).values(expired);
    const liveToken = randomUUID();
    await database.insert(schema.visitorAdmission).values({
      visitorKey: otherKey, windowStartedAt: sql`DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 60 SECOND)`, requestCount: 30,
      leaseToken: liveToken, leaseExpiresAt: sql`DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 120 SECOND)`,
      expiresAt: sql`DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 120 SECOND)`,
    });
    await repository.consumeRequest(key);
    const [remaining] = await database.select({ value: count() }).from(schema.visitorAdmission)
      .where(lte(schema.visitorAdmission.expiresAt, sql`UTC_TIMESTAMP(3)`));
    assert.equal(remaining.value, 6);
    assert.equal((await stored(otherKey)).leaseToken, liveToken);
    await assert.rejects(repository.acquireScan(otherKey), VisitorScanActiveError);
  });

  test("a blocked visitor row does not block admission for another visitor", async () => {
    await repository.consumeRequest(key);
    const blocker = await pool.getConnection();
    let blockedRequest: Promise<unknown> | undefined;
    let blockedCompleted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await blocker.beginTransaction();
      await blocker.execute("SELECT visitor_key FROM visitor_admission WHERE visitor_key = ? FOR UPDATE", [key]);
      blockedRequest = repository.consumeRequest(key).then(() => { blockedCompleted = true; });
      await Promise.race([
        repository.consumeRequest(otherKey),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("An unrelated visitor waited for another visitor's row lock.")), 4000); }),
      ]);
      assert.equal(blockedCompleted, false);
      assert.equal((await stored(otherKey)).requestCount, 1);
    } finally {
      if (timer) clearTimeout(timer);
      await blocker.rollback();
      blocker.release();
      await blockedRequest;
    }
    assert.equal(blockedCompleted, true);
    assert.equal((await stored(key)).requestCount, 2);
  });

  test("lease expiry is based on the DB clock and is exactly330 seconds", async () => {
    const started = await clock();
    const lease = await repository.acquireScan(key);
    const row = await stored();
    const finished = await clock();
    assert.ok(row.leaseExpiresAt);
    assert.ok(row.leaseExpiresAt.getTime() >= started + 330_000);
    assert.ok(row.leaseExpiresAt.getTime() <= finished + 330_000);
    assert.equal(row.expiresAt.getTime(), row.leaseExpiresAt.getTime());
    await lease.release();
  });
});
