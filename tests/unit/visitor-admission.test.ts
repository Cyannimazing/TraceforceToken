import assert from "node:assert/strict";
import test from "node:test";
import { drizzle } from "drizzle-orm/mysql2";
import type { Connection } from "mysql2/promise";
import * as schema from "../../src/db/schema";
import {
  createVisitorAdmissionRepository, InvalidVisitorKeyError, VisitorAdmissionUnavailableError,
  VisitorRateLimitError, VisitorScanActiveError,
} from "../../src/repositories/visitor-admission";

interface Statement { sql: string; values: unknown[] }
const visitorKey = "a".repeat(64);
const now = 1_800_000_005_250;
const currentWindow = now;
const previousToken = "3c856ea9-a3ad-45ed-980e-52bb349f05f7";
const row = (options: { window?: number; count?: number; token?: string | null; clock?: number; lease?: number | null } = {}) => [
  options.window ?? currentWindow, options.count ?? 0, options.token ?? null,
  options.clock ?? now, options.lease ?? null,
];

/** Records generated SQL, not an emulation of database concurrency or locks. */
function recordingDatabase(respond: (statement: Statement) => unknown = ({ sql }) => sql.includes("TIMESTAMPDIFF") ? [row()] : sql.startsWith("select") ? [] : { affectedRows: 1 }) {
  const statements: Statement[] = [];
  const driver = { async query(query: { sql: string }, values: unknown[] = []) {
    const statement = { sql: query.sql, values };
    statements.push(statement);
    return [respond(statement), []];
  } };
  const database = drizzle(driver as unknown as Connection, { schema, mode: "default" }) as Parameters<typeof createVisitorAdmissionRepository>[0];
  return { statements, repository: createVisitorAdmissionRepository(database) };
}

test("visitor burst uses one independent locked row and captured DB UTC time, without hourly or report storage", async () => {
  const { repository, statements } = recordingDatabase();
  assert.deepEqual(await repository.consumeRequest(visitorKey), { retryAfterSeconds: 30 });
  assert.match(statements[0].sql, /isolation level read committed/i);
  assert.equal(statements[1].sql, "begin");
  assert.match(statements[2].sql, /insert into `visitor_admission`.*on duplicate key update/);
  assert.match(statements[3].sql, /UTC_TIMESTAMP\(3\).*where `visitor_admission`\.`visitor_key` = \? for update$/);
  assert.deepEqual(statements[3].values, [visitorKey]);
  const update = statements.find(({ sql }) => sql.startsWith("update"))!;
  assert.equal(update.values[0], "2027-01-15 08:00:05.250");
  assert.equal(update.values[1], 1);
  assert.ok(update.values.includes("2027-01-15 08:00:35.250"));
  assert.equal(statements.some(({ sql }) => /queue_guard|scan_admission|investigation_jobs|investigation_evidence|`investigations`|TIMESTAMPDIFF\(HOUR/.test(sql)), false);
  assert.equal(statements[5].sql, "commit");
  assert.match(statements[6].sql, /^select.*expires_at.*lease_expires_at.*limit \?$/);
  assert.deepEqual(statements[6].values, [20]);
});

test("the 31st request rejects with accurate retry and rolls back without increment or cleanup", async () => {
  const { repository, statements } = recordingDatabase(({ sql }) => sql.includes("TIMESTAMPDIFF") ? [row({ window: now - 5250, count: 30 })] : { affectedRows: 1 });
  await assert.rejects(repository.consumeRequest(visitorKey), (error: unknown) => error instanceof VisitorRateLimitError && error.retryAfterSeconds === 25);
  assert.equal(statements.some(({ sql }) => sql.startsWith("update") || sql.startsWith("delete")), false);
  assert.equal(statements.at(-1)?.sql, "rollback");
});

test("a new 30-second window resets only the burst count and retains a live scan's expiry", async () => {
  const lease = now + 200_000;
  const { repository, statements } = recordingDatabase(({ sql }) => sql.includes("TIMESTAMPDIFF")
    ? [row({ window: currentWindow - 30_000, count: 30, token: previousToken, lease })]
    : sql.startsWith("select") ? [] : { affectedRows: 1 });
  await repository.consumeRequest(visitorKey);
  const update = statements.find(({ sql }) => sql.startsWith("update"))!;
  assert.deepEqual(update.values.slice(0, 2), ["2027-01-15 08:00:05.250", 1]);
  assert.ok(update.values.includes(new Date(lease).toISOString().replace("T", " ").slice(0, 23)));
  assert.doesNotMatch(update.sql, /set .*`lease_token`|set .*`lease_expires_at`/);
});

test("acquiring a 330-second lease adds no burst request and release is token-conditional and repeatable", async () => {
  const { repository, statements } = recordingDatabase();
  const lease = await repository.acquireScan(visitorKey);
  assert.match(lease.token, /^[0-9a-f-]{36}$/);
  const acquisition = statements.find(({ sql }) => sql.startsWith("update"))!;
  assert.ok(acquisition.values.includes(lease.token));
  assert.ok(acquisition.values.includes(new Date(now + 330_000).toISOString().replace("T", " ").slice(0, 23)));
  assert.doesNotMatch(acquisition.sql, /set .*`request_count`|set .*`window_started_at`/);
  await lease.release();
  await lease.release();
  const releases = statements.filter(({ sql }) => sql.startsWith("update") && sql.includes("`lease_token` = ?") && sql.includes("GREATEST"));
  assert.equal(releases.length, 2);
  for (const release of releases) {
    assert.match(release.sql, /where \(`visitor_admission`\.`visitor_key` = \? and `visitor_admission`\.`lease_token` = \?\)$/);
    assert.deepEqual(release.values.slice(-2), [visitorKey, lease.token]);
  }
});

test("live leases reject another scan with a ceiling-rounded bounded retry and no mutation", async () => {
  const { repository, statements } = recordingDatabase(({ sql }) => sql.includes("TIMESTAMPDIFF")
    ? [row({ token: previousToken, lease: now + 123_250 })] : { affectedRows: 1 });
  await assert.rejects(repository.acquireScan(visitorKey), (error: unknown) => error instanceof VisitorScanActiveError && error.retryAfterSeconds === 124);
  assert.equal(statements.some(({ sql }) => sql.startsWith("update")), false);
  assert.equal(statements.at(-1)?.sql, "rollback");
});

test("expired scan lease is replaced with a distinct token", async () => {
  const { repository } = recordingDatabase(({ sql }) => sql.includes("TIMESTAMPDIFF")
    ? [row({ token: previousToken, lease: now })] : sql.startsWith("select") ? [] : { affectedRows: 1 });
  assert.notEqual((await repository.acquireScan(visitorKey)).token, previousToken);
});

test("expiry cleanup runs after commit, uses bounded nonlocking discovery and per-key deletes that exclude live leases", async () => {
  const expiredKey = "b".repeat(64);
  const { repository, statements } = recordingDatabase(({ sql }) => sql.includes("TIMESTAMPDIFF") ? [row()]
    : sql.startsWith("select") ? [[expiredKey]] : { affectedRows: 1 });
  await repository.consumeRequest(visitorKey);
  const deletion = statements.find(({ sql }) => sql.startsWith("delete"))!;
  assert.ok(statements.indexOf(deletion) > statements.findIndex(({ sql }) => sql === "commit"));
  assert.match(deletion.sql, /visitor_key.*expires_at.*lease_expires_at.*limit \?$/);
  assert.deepEqual(deletion.values, [expiredKey, 1]);
  assert.doesNotMatch(statements.at(-2)!.sql, /for update/);
});

test("malformed visitor identities are rejected before any database access", async () => {
  const { repository, statements } = recordingDatabase();
  for (const key of ["", "127.0.0.1", "a".repeat(63), "A".repeat(64), "x".repeat(64)]) {
    await assert.rejects(repository.consumeRequest(key), InvalidVisitorKeyError);
    await assert.rejects(repository.acquireScan(key), InvalidVisitorKeyError);
  }
  assert.equal(statements.length, 0);
});

test("corrupt DB clock, count, window and lease metadata fail closed with rollback", async () => {
  for (const badRow of [
    row({ clock: -1 }), row({ clock: Number.NaN }), row({ count: 31 }),
    row({ window: currentWindow + 1 }), row({ token: previousToken }),
    row({ lease: now + 1000 }), row({ token: "invalid", lease: now + 1000 }),
    row({ token: previousToken, lease: now + 331_000 }),
  ]) {
    const { repository, statements } = recordingDatabase(({ sql }) => sql.includes("TIMESTAMPDIFF") ? [badRow] : { affectedRows: 1 });
    await assert.rejects(repository.consumeRequest(visitorKey), VisitorAdmissionUnavailableError);
    assert.equal(statements.at(-1)?.sql, "rollback");
  }
});

test("primary admission and release SQL failures expose no upstream credentials", async () => {
  const failure = () => { throw new Error("mysql://private-user:private-password@private-host/private-database"); };
  const { repository } = recordingDatabase(failure);
  const safe = (error: unknown) => {
    assert.ok(error instanceof VisitorAdmissionUnavailableError);
    assert.doesNotMatch(error.message, /private-user|private-password|private-host|private-database/);
    return true;
  };
  await assert.rejects(repository.consumeRequest(visitorKey), safe);
  await assert.rejects(repository.acquireScan(visitorKey), safe);
  const recording = recordingDatabase(({ sql }) => sql.includes("TIMESTAMPDIFF") ? [row()]
    : sql.startsWith("update") && sql.includes("GREATEST") ? failure()
      : sql.startsWith("select") ? [] : { affectedRows: 1 });
  const lease = await recording.repository.acquireScan(visitorKey);
  await assert.rejects(lease.release(), safe);
});

test("post-commit housekeeping failure does not turn an already admitted request into a false failure", async () => {
  const { repository, statements } = recordingDatabase(({ sql }) => {
    if (sql.includes("TIMESTAMPDIFF")) return [row()];
    if (sql.startsWith("select")) throw new Error("Synthetic housekeeping outage");
    return { affectedRows: 1 };
  });
  await repository.consumeRequest(visitorKey);
  assert.ok(statements.some(({ sql }) => sql === "commit"));
});

test("public retry values are finite, positive and bounded", () => {
  assert.equal(new VisitorRateLimitError(Number.NaN).retryAfterSeconds, 30);
  assert.equal(new VisitorRateLimitError(100).retryAfterSeconds, 30);
  assert.equal(new VisitorRateLimitError(0).retryAfterSeconds, 1);
  assert.equal(new VisitorScanActiveError(Number.NaN).retryAfterSeconds, 330);
  assert.equal(new VisitorScanActiveError(999).retryAfterSeconds, 330);
  assert.equal(new VisitorScanActiveError(-1).retryAfterSeconds, 1);
});
