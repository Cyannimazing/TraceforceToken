import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { count, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { readDatabaseConfig } from "../../src/db/config";
import { loadDatabaseEnvironment } from "../../scripts/database/environment";
import * as schema from "../../src/db/schema";
import { createScanAdmissionRepository } from "../../src/repositories/scan-admission";
import type { ExplainedInvestigationReport, ScanParameters } from "../../src/domain/investigations/types";
import {
  createInvestigationRepository,
  InvalidInvestigationJobError,
  QueueCapacityError,
  ScanRateLimitError,
  type InvestigationRepository,
  type TraceforgeDatabase,
} from "../../src/repositories/investigations";

loadDatabaseEnvironment();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL is required. These genuine MySQL/MariaDB integration tests did not run; configure a disposable local database and explicitly apply migrations first.");
}

const configuration = readDatabaseConfig({
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  DATABASE_SSL: process.env.TEST_DATABASE_SSL ?? "false",
  DATABASE_CA_CERT: process.env.TEST_DATABASE_CA_CERT,
  DATABASE_POOL_SIZE: "10",
});
if (!["localhost", "127.0.0.1", "::1"].includes(configuration.host!) || !configuration.database?.startsWith("traceforge_test_")) {
  throw new Error("Database integration tests require a local disposable database named traceforge_test_*. Job tables are reset during each test.");
}

const parameters: ScanParameters = {
  token: "0xabcd000000000000000000000000000000000000",
  lookbackBlocks: 500,
};

function report(id: string): ExplainedInvestigationReport {
  return {
    schemaVersion: 1, id, generatedAt: "2026-10-12T00:00:00.000Z", mode: "live",
    token: { address: parameters.token, chainId: 8453, name: null, symbol: null, decimals: null, totalSupplyRaw: null },
    range: {
      from: { number: "1", hash: `0x${"1".repeat(64)}`, timestamp: 1 },
      to: { number: "2", hash: `0x${"2".repeat(64)}`, timestamp: 2 }, finality: "finalized",
    },
    coverage: { transfers: "partial", funding: [], eligibleWallets: 0, examinedWallets: 0, warnings: ["Disposable database integration fixture"] },
    summary: "Disposable database integration fixture",
    wallets: [], connections: [], groups: [], findings: [], story: [], evidence: [],
    explanation: {
      schemaVersion: 1, reportId: id, profileId: "on-chain-investigator", profileVersion: "1.0.0",
      model: "synthetic-database-test", generatedAt: "2026-10-12T00:00:00.000Z",
      overview: { text: "Synthetic database fixture: no evidence was retained, so activity outside partial coverage is unknown.", evidenceIds: [] },
      observations: [], limitations: ["Synthetic database fixture; this is not a real AI or blockchain result."],
      context: { evidenceIds: [], suppliedEvidence: 0, omittedEvidence: 0 }, authority: "non-authoritative-commentary",
    },
  };
}

describe("genuine local MySQL/MariaDB durable job integration", { concurrency: false }, () => {
  let pool: Pool;
  let database: TraceforgeDatabase;
  let repository: InvestigationRepository;
  let ready = false;

  before(async () => {
    pool = createPool(configuration);
    database = drizzle(pool, { schema, mode: "default" });
    repository = createInvestigationRepository(database);
    try {
      // Read only: applying migrations is an explicit prerequisite, never a test hook.
      await database.select({ id: schema.investigationJobs.id }).from(schema.investigationJobs).limit(1);
      await database.select().from(schema.investigationQueueGuard).limit(1);
      await database.select().from(schema.investigationScanAdmission).limit(1);
      ready = true;
    } catch {
      throw new Error("The disposable local database is unavailable or migrations through 0002 are missing. No migration was automatically applied.");
    }
  });

  beforeEach(async () => {
    await database.delete(schema.investigationJobs);
    await database.delete(schema.investigationQueueGuard);
    await database.delete(schema.investigationScanAdmission);
  });

  after(async () => {
    if (ready) {
      await database.delete(schema.investigationJobs);
      await database.delete(schema.investigationQueueGuard);
      await database.delete(schema.investigationScanAdmission);
    }
    if (pool) await pool.end();
  });

  test("admission-only concurrent reservations enforce five per client and create no saved work", async () => {
    const admission = createScanAdmissionRepository(database);
    await database.insert(schema.investigationQueueGuard).values({ id: 1 });
    const [clock] = await database.select({
      seconds: sql<number>`3600 - MOD(TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)), 3600)`.mapWith(Number),
    }).from(schema.investigationQueueGuard).limit(1);
    if (clock.seconds < 15) await new Promise((resolve) => setTimeout(resolve, (clock.seconds + 1) * 1000));
    const key = "c".repeat(64);
    const reservations = await Promise.allSettled(Array.from({ length: 12 }, () => admission.reserveScan(key)));
    assert.equal(reservations.filter((result) => result.status === "fulfilled").length, 5);
    for (const result of reservations.filter((entry) => entry.status === "rejected")) assert.ok(result.reason instanceof ScanRateLimitError);
    await admission.reserveScan("d".repeat(64));
    const counters = await database.select().from(schema.investigationScanAdmission);
    assert.equal(counters.length, 2);
    assert.equal(counters.find((entry) => entry.clientKey === key)?.acceptedCount, 5);
    assert.equal(counters.find((entry) => entry.clientKey === "d".repeat(64))?.acceptedCount, 1);
    const [jobs] = await database.select({ value: count() }).from(schema.investigationJobs);
    const [investigations] = await database.select({ value: count() }).from(schema.investigations);
    const [evidence] = await database.select({ value: count() }).from(schema.investigationEvidence);
    assert.equal(jobs.value, 0, "admission must not insert jobs or saved reports");
    assert.equal(investigations.value, 0);
    assert.equal(evidence.value, 0);
  });

  test("admission-only rate rejection preserves counters and expiry cleanup remains bounded", async () => {
    const admission = createScanAdmissionRepository(database);
    await database.insert(schema.investigationQueueGuard).values({ id: 1 });
    const [clock] = await database.select({
      hour: sql<number>`TIMESTAMPDIFF(HOUR, '1970-01-01 00:00:00', UTC_TIMESTAMP(3))`.mapWith(Number),
    }).from(schema.investigationQueueGuard).limit(1);
    await database.insert(schema.investigationScanAdmission).values(Array.from({ length: 105 }, (_, index) => ({
      clientKey: index.toString(16).padStart(64, "0"), windowHour: clock.hour - 1, acceptedCount: 5,
      expiresAt: sql`DATE_ADD('1970-01-01 00:00:00', INTERVAL ${clock.hour} HOUR)`,
    })));
    const fullKey = "e".repeat(64);
    await database.insert(schema.investigationScanAdmission).values({
      clientKey: fullKey, windowHour: clock.hour, acceptedCount: 5,
      expiresAt: sql`DATE_ADD('1970-01-01 00:00:00', INTERVAL ${clock.hour + 1} HOUR)`,
    });
    await assert.rejects(admission.reserveScan(fullKey), ScanRateLimitError);
    const rejected = await database.select().from(schema.investigationScanAdmission);
    assert.equal(rejected.length, 106, "rejected traffic must not prune or increment quota");
    assert.equal(rejected.find((entry) => entry.clientKey === fullKey)?.acceptedCount, 5);
    await admission.reserveScan("f".repeat(64));
    const accepted = await database.select().from(schema.investigationScanAdmission);
    assert.equal(accepted.filter((entry) => entry.windowHour === clock.hour - 1).length, 5);
    assert.equal(accepted.find((entry) => entry.clientKey === "f".repeat(64))?.acceptedCount, 1);
    const [jobs] = await database.select({ value: count() }).from(schema.investigationJobs);
    assert.equal(jobs.value, 0);
  });

  test("concurrent enqueues reserve the final capacity slot exactly once", async () => {
    await database.insert(schema.investigationJobs).values(Array.from({ length: 99 }, () => ({
      id: randomUUID(), parameters,
      availableAt: sql`UTC_TIMESTAMP(3)`, createdAt: sql`UTC_TIMESTAMP(3)`, updatedAt: sql`UTC_TIMESTAMP(3)`,
    })));
    const clientKey = "a".repeat(64);
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => repository.enqueue(parameters, { clientKey })));
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = attempts.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 11);
    for (const result of rejected) assert.ok(result.reason instanceof QueueCapacityError);
    const [active] = await database.select({ value: count() }).from(schema.investigationJobs)
      .where(inArray(schema.investigationJobs.status, ["queued", "running"]));
    assert.equal(active.value, 100);
    const [admission] = await database.select().from(schema.investigationScanAdmission);
    assert.equal(admission.acceptedCount, 1, "queue-full requests must not consume client quota");
  });

  test("distributed concurrent admission accepts five per UTC hour and isolates other clients", async () => {
    // Avoid a real hour boundary splitting the concurrent sample into two valid
    // windows. This is the real DB clock, never a simulated repository clock.
    const [clock] = await database.select({
      seconds: sql<number>`3600 - MOD(TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)), 3600)`.mapWith(Number),
    }).from(schema.investigationQueueGuard).limit(1);
    // The guard may not exist yet after cleanup; create it without claiming work.
    if (!clock) await database.insert(schema.investigationQueueGuard).values({ id: 1 });
    const [current] = await database.select({
      seconds: sql<number>`3600 - MOD(TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)), 3600)`.mapWith(Number),
    }).from(schema.investigationQueueGuard).limit(1);
    if (current.seconds < 15) await new Promise((resolve) => setTimeout(resolve, (current.seconds + 1) * 1000));
    const clientKey = "a".repeat(64);
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => repository.enqueue(parameters, { clientKey })));
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 5);
    for (const rejected of attempts.filter((result) => result.status === "rejected")) {
      assert.ok(rejected.reason instanceof ScanRateLimitError);
      assert.ok(rejected.reason.retryAfterSeconds >= 1 && rejected.reason.retryAfterSeconds <= 3600);
    }
    let counters = await database.select().from(schema.investigationScanAdmission);
    assert.equal(counters.length, 1);
    assert.equal(counters[0].acceptedCount, 5);
    await repository.enqueue(parameters, { clientKey: "b".repeat(64) });
    counters = await database.select().from(schema.investigationScanAdmission);
    assert.equal(counters.length, 2);
    assert.equal(counters.find((entry) => entry.clientKey === clientKey)?.acceptedCount, 5);
    assert.equal(counters.find((entry) => entry.clientKey === "b".repeat(64))?.acceptedCount, 1);
    const [jobs] = await database.select({ value: count() }).from(schema.investigationJobs);
    assert.equal(jobs.value, 6, "rejected quota attempts must not leave queued jobs");
  });

  test("admission expires on DB UTC hours and cleanup deletes no more than 100 old buckets", async () => {
    await database.insert(schema.investigationQueueGuard).values({ id: 1 });
    const [clock] = await database.select({
      hour: sql<number>`TIMESTAMPDIFF(HOUR, '1970-01-01 00:00:00', UTC_TIMESTAMP(3))`.mapWith(Number),
    }).from(schema.investigationQueueGuard).limit(1);
    await database.insert(schema.investigationScanAdmission).values(Array.from({ length: 105 }, (_, index) => ({
      clientKey: index.toString(16).padStart(64, "0"), windowHour: clock.hour - 1, acceptedCount: 5,
      expiresAt: sql`DATE_ADD('1970-01-01 00:00:00', INTERVAL ${clock.hour} HOUR)`,
    })));
    const reusedClient = "0".repeat(64);
    await repository.enqueue(parameters, { clientKey: reusedClient });
    const remaining = await database.select().from(schema.investigationScanAdmission);
    assert.equal(remaining.filter((entry) => entry.windowHour === clock.hour - 1).length, 5);
    assert.equal(remaining.find((entry) => entry.clientKey === reusedClient && entry.windowHour === clock.hour)?.acceptedCount, 1);
  });

  test("concurrent workers exclusively claim one queued job", async () => {
    const queued = await repository.enqueue(parameters);
    const claims = await Promise.all(Array.from({ length: 8 }, () => repository.claimNext()));
    const owners = claims.filter((claim) => claim !== null);
    assert.equal(owners.length, 1);
    assert.equal(owners[0].job.id, queued.id);
    assert.equal(owners[0].job.attempts, 1);
    assert.equal((await repository.get(queued.id))?.status, "running");
  });

  test("expired ownership cannot heartbeat or publish, and recovery issues a new token", async () => {
    const queued = await repository.enqueue(parameters);
    const first = (await repository.claimNext())!;
    assert.equal(await repository.heartbeat(queued.id, randomUUID(), "wrong owner"), false);
    assert.equal(await repository.heartbeat(queued.id, first.leaseToken, "owned progress"), true);
    await database.update(schema.investigationJobs).set({ leaseExpiresAt: sql`DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND)` })
      .where(eq(schema.investigationJobs.id, queued.id));
    assert.equal(await repository.heartbeat(queued.id, first.leaseToken, "expired progress"), false);
    assert.equal(await repository.complete(queued.id, first.leaseToken, report(queued.id)), false);
    assert.equal(await repository.fail(queued.id, first.leaseToken, "Data sources were unavailable."), false);
    const recovered = (await repository.claimNext())!;
    assert.equal(recovered.job.id, queued.id);
    assert.equal(recovered.job.attempts, 2);
    assert.notEqual(recovered.leaseToken, first.leaseToken);
    assert.equal(await repository.complete(queued.id, first.leaseToken, report(queued.id)), false);
    assert.equal(await repository.heartbeat(queued.id, recovered.leaseToken, "recovered progress"), true);
  });

  test("failure backoff is durable and third attempt terminates", async () => {
    const queued = await repository.enqueue(parameters);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = (await repository.claimNext())!;
      assert.equal(claimed.job.attempts, attempt);
      assert.equal(await repository.fail(queued.id, claimed.leaseToken, "provider password=private-secret"), true);
      const saved = (await repository.get(queued.id))!;
      assert.equal(saved.error, "Investigation could not be completed.");
      if (attempt < 3) {
        assert.equal(saved.status, "queued");
        assert.equal(await repository.claimNext(), null);
        const [stored] = await database.select({ delay: sql<number>`TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), ${schema.investigationJobs.availableAt})` })
          .from(schema.investigationJobs).where(eq(schema.investigationJobs.id, queued.id));
        const expected = 30 * 2 ** (attempt - 1);
        assert.ok(Number(stored.delay) >= expected - 10 && Number(stored.delay) <= expected);
        await database.update(schema.investigationJobs).set({ availableAt: sql`DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND)` })
          .where(eq(schema.investigationJobs.id, queued.id));
      } else {
        assert.equal(saved.status, "failed");
        assert.equal(await repository.claimNext(), null);
      }
    }
  });

  test("an exhausted crashed worker becomes failed rather than endlessly reclaimable", async () => {
    const queued = await repository.enqueue(parameters);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = (await repository.claimNext())!;
      assert.equal(claimed.job.attempts, attempt);
      await database.update(schema.investigationJobs).set({ leaseExpiresAt: sql`DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND)` })
        .where(eq(schema.investigationJobs.id, queued.id));
    }
    assert.equal(await repository.claimNext(), null);
    const saved = (await repository.get(queued.id))!;
    assert.equal(saved.status, "failed");
    assert.equal(saved.attempts, 3);
  });

  test("completion checks report identity, token ownership, and immutable terminal state", async () => {
    const queued = await repository.enqueue(parameters);
    const claimed = (await repository.claimNext())!;
    const missingExplanation = report(queued.id);
    Reflect.deleteProperty(missingExplanation, "explanation");
    await assert.rejects(repository.complete(queued.id, claimed.leaseToken, missingExplanation), InvalidInvestigationJobError);
    const inventedCitation = report(queued.id);
    inventedCitation.explanation.overview.evidenceIds = ["not-in-report"];
    await assert.rejects(repository.complete(queued.id, claimed.leaseToken, inventedCitation), InvalidInvestigationJobError);
    assert.equal((await repository.get(queued.id))?.status, "running", "missing/invalid AI must not complete the job");
    await assert.rejects(repository.complete(queued.id, claimed.leaseToken, report(randomUUID())), InvalidInvestigationJobError);
    const wrongToken = report(queued.id);
    wrongToken.token.address = "0xdddd000000000000000000000000000000000000";
    assert.equal(await repository.complete(queued.id, claimed.leaseToken, wrongToken), false);
    assert.equal(await repository.complete(queued.id, randomUUID(), report(queued.id)), false);
    assert.equal(await repository.complete(queued.id, claimed.leaseToken, report(queued.id)), true);
    const completed = (await repository.get(queued.id))!;
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.report, report(queued.id));
    assert.equal(await repository.complete(queued.id, claimed.leaseToken, report(queued.id)), false);
    assert.equal(await repository.fail(queued.id, claimed.leaseToken, "Data sources were unavailable."), false);
    assert.equal(await repository.claimNext(), null);
  });
});
