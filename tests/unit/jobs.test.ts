import assert from "node:assert/strict";
import test from "node:test";
import { drizzle } from "drizzle-orm/mysql2";
import type { Connection } from "mysql2/promise";
import * as schema from "../../src/db/schema";
import type { ExplainedInvestigationReport, ScanParameters } from "../../src/domain/investigations/types";
import {
  createInvestigationRepository,
  InvalidInvestigationJobError,
  InvestigationRepositoryUnavailableError,
  QueueCapacityError,
  ScanRateLimitError,
  sanitizeInvestigationError,
  type TraceforgeDatabase,
} from "../../src/repositories/investigations";

const jobId = "56816592-f395-4c56-bf85-479e8e51ef2a";
const leaseToken = "3c856ea9-a3ad-45ed-980e-52bb349f05f7";
const token = "0xabcd000000000000000000000000000000000000" as const;
const parameters: ScanParameters = { token, lookbackBlocks: 500 };

interface Statement { sql: string; values: unknown[] }

/** Records Drizzle's real SQL; it does not emulate MySQL locks or transactions. */
function recordingDatabase(respond: (statement: Statement) => unknown = () => ({ affectedRows: 1, insertId: 0 })) {
  const statements: Statement[] = [];
  const driver = {
    async query(query: { sql: string }, values: unknown[] = []) {
      const statement = { sql: query.sql, values };
      statements.push(statement);
      return [respond(statement), []];
    },
  };
  const database = drizzle(driver as unknown as Connection, { schema, mode: "default" }) as TraceforgeDatabase;
  return { statements, repository: createInvestigationRepository(database) };
}

function row(options: { id?: string; status?: string; attempts?: number; lease?: string | null } = {}) {
  return [
    options.id ?? jobId, options.status ?? "queued", JSON.stringify(parameters), "queued",
    options.attempts ?? 0, 3, "2026-10-12 00:00:00.000", options.lease ?? null,
    options.lease ? "2026-10-12 00:02:00.000" : null, null, null,
    "2026-10-12 00:00:00.000", "2026-10-12 00:00:00.000",
  ];
}

function report(): ExplainedInvestigationReport {
  return {
    schemaVersion: 1, id: jobId, generatedAt: "2026-10-12T00:00:00.000Z", mode: "live",
    token: { address: token, chainId: 8453, name: null, symbol: null, decimals: null, totalSupplyRaw: null },
    range: {
      from: { number: "1", hash: `0x${"1".repeat(64)}`, timestamp: 1 },
      to: { number: "2", hash: `0x${"2".repeat(64)}`, timestamp: 2 }, finality: "finalized",
    },
    coverage: { transfers: "partial", funding: [], eligibleWallets: 0, examinedWallets: 0, warnings: ["Partial fixture"] },
    summary: "Partial fixture", wallets: [], connections: [], groups: [], findings: [], story: [], evidence: [],
    explanation: {
      schemaVersion: 1, reportId: jobId, profileId: "on-chain-investigator", profileVersion: "1.0.0",
      model: "synthetic-repository-test", generatedAt: "2026-10-12T00:00:00.000Z",
      overview: { text: "Synthetic fixture with no retained evidence. Activity beyond the partial examined coverage is unknown.", evidenceIds: [] },
      observations: [], limitations: ["Synthetic offline fixture; no real AI or chain observation."],
      context: { evidenceIds: [], suppliedEvidence: 0, omittedEvidence: 0 }, authority: "non-authoritative-commentary",
    },
  };
}

test("lazy repository import does not require database credentials for invalid identities", async () => {
  const repository = createInvestigationRepository();
  assert.equal(await repository.get("not-a-uuid"), null);
  assert.equal(await repository.heartbeat("not-a-uuid", leaseToken, "starting"), false);
});

test("capacity reservation locks the singleton before counting and rolls back a full queue", async () => {
  const { repository, statements } = recordingDatabase(({ sql }) => sql.includes("count(*)") ? [[100]] : { affectedRows: 1 });
  await assert.rejects(repository.enqueue(parameters), QueueCapacityError);
  const texts = statements.map((statement) => statement.sql);
  assert.match(texts[0], /isolation level read committed/i);
  assert.match(texts[1], /^begin$/i);
  assert.match(texts[2], /insert into `investigation_queue_guard`.*on duplicate key update/);
  assert.match(texts[3], /count\(\*\).*investigation_jobs/);
  assert.equal(texts.some((sql) => /insert into `investigation_jobs`/.test(sql)), false);
  assert.equal(texts.at(-1), "rollback");
});

test("accepted enqueue canonicalizes identity and commits durable rows using database UTC", async () => {
  let createdId = "";
  const { repository, statements } = recordingDatabase(({ sql, values }) => {
    if (sql.includes("count(*)")) return [[0]];
    if (sql.startsWith("insert into `investigation_jobs`")) createdId = values[0] as string;
    if (sql.startsWith("select") && sql.includes("from `investigation_jobs`")) return [row({ id: createdId })];
    return { affectedRows: 1, insertId: 0 };
  });
  const job = await repository.enqueue({ ...parameters, token: token.toUpperCase().replace("0X", "0x") as ScanParameters["token"] });
  assert.equal(job.id, createdId);
  assert.equal(job.parameters.token, token);
  const insertion = statements.find((statement) => statement.sql.startsWith("insert into `investigation_jobs`"))!;
  assert.equal((insertion.sql.match(/UTC_TIMESTAMP\(3\)/g) ?? []).length, 3);
  assert.ok(insertion.values.some((value) => typeof value === "string" && value.includes(token)));
  assert.equal(statements.at(-1)?.sql, "commit");
});

test("public admission uses one database UTC hour, an opaque key, and bounded expiry cleanup", async () => {
  const clientKey = "a".repeat(64);
  let createdId = "";
  const { repository, statements } = recordingDatabase(({ sql, values }) => {
    if (sql.includes("count(*)")) return [[0]];
    if (sql.includes("TIMESTAMPDIFF(HOUR")) return [[497690, 1234]];
    if (sql.startsWith("select") && sql.includes("investigation_scan_admission")) return [[4]];
    if (sql.startsWith("insert into `investigation_jobs`")) createdId = values[0] as string;
    if (sql.startsWith("select") && sql.includes("from `investigation_jobs`")) return [row({ id: createdId })];
    return { affectedRows: 1, insertId: 0 };
  });
  await repository.enqueue(parameters, { clientKey });
  const cleanup = statements.find((statement) => statement.sql.startsWith("delete"))!;
  assert.match(cleanup.sql, /expires_at.*DATE_ADD.*limit \?/);
  assert.deepEqual(cleanup.values, [497690, 100]);
  const quota = statements.find((statement) => statement.sql.startsWith("insert into `investigation_scan_admission`"))!;
  assert.ok(quota.values.includes(clientKey));
  assert.ok(quota.values.includes(497690));
  assert.ok(quota.values.includes(497691));
  assert.match(quota.sql, /on duplicate key update.*accepted_count.*\+ 1/);
  assert.ok(statements.indexOf(quota) > statements.findIndex((statement) => statement.sql.startsWith("insert into `investigation_jobs`")));
  assert.equal(statements.at(-1)?.sql, "commit");
});

test("rate rejection rolls back without inserting work or spending another quota unit", async () => {
  const { repository, statements } = recordingDatabase(({ sql }) => {
    if (sql.includes("count(*)")) return [[0]];
    if (sql.includes("TIMESTAMPDIFF(HOUR")) return [[497690, 43]];
    if (sql.startsWith("select") && sql.includes("investigation_scan_admission")) return [[5]];
    return { affectedRows: 1 };
  });
  await assert.rejects(repository.enqueue(parameters, { clientKey: "a".repeat(64) }), (error: unknown) => {
    assert.ok(error instanceof ScanRateLimitError);
    assert.equal(error.retryAfterSeconds, 43);
    assert.doesNotMatch(error.message, /[a-f0-9]{64}/);
    return true;
  });
  assert.equal(statements.some((statement) => /^insert into `investigation_(jobs|scan_admission)`/.test(statement.sql)), false);
  assert.equal(statements.some((statement) => statement.sql.startsWith("delete")), false, "rate-rejected traffic must not perform cleanup writes");
  assert.equal(statements.at(-1)?.sql, "rollback");
});

test("public identity validation rejects raw addresses and malformed keys before database use", async () => {
  const { repository, statements } = recordingDatabase();
  for (const clientKey of ["127.0.0.1", "x".repeat(64), "A".repeat(64), "a".repeat(63), ""]) {
    await assert.rejects(repository.enqueue(parameters, { clientKey }), InvalidInvestigationJobError);
  }
  assert.equal(statements.length, 0);
  assert.equal(new ScanRateLimitError(0).retryAfterSeconds, 1);
  assert.equal(new ScanRateLimitError(9999).retryAfterSeconds, 3600);
  assert.equal(new ScanRateLimitError(Number.NaN).retryAfterSeconds, 3600);
});

test("claim SQL locks eligible work and atomically increments attempts before commit", async () => {
  let claimedToken: string | null = null;
  const { repository, statements } = recordingDatabase(({ sql, values }) => {
    if (sql.startsWith("select")) return [row({ status: claimedToken ? "running" : "queued", attempts: claimedToken ? 1 : 0, lease: claimedToken })];
    if (sql.startsWith("update") && values.includes("starting")) {
      claimedToken = values.find((value) => typeof value === "string" && /^[0-9a-f-]{36}$/.test(value) && value !== jobId) as string;
    }
    return { affectedRows: 1, insertId: 0 };
  });
  const claimed = await repository.claimNext({ leaseSeconds: 120, maxAttempts: 3 });
  assert.equal(claimed?.job.attempts, 1);
  assert.equal(claimed?.leaseToken, claimedToken);
  const selection = statements.find((statement) => statement.sql.includes("for update"))!;
  assert.match(selection.sql, /available_at.*UTC_TIMESTAMP\(3\)/);
  assert.match(selection.sql, /lease_expires_at.*UTC_TIMESTAMP\(3\)/);
  assert.match(selection.sql, /limit \? for update$/);
  const recovery = statements.find((statement) => statement.values.includes("The worker lease expired before completion."))!;
  assert.match(recovery.sql, /`attempts` >= LEAST\(`investigation_jobs`\.`max_attempts`, \?\)/);
  const mutation = statements.find((statement) => statement.values.includes("starting"))!;
  assert.match(mutation.sql, /`attempts` = `investigation_jobs`\.`attempts` \+ 1/);
  assert.equal(statements.at(-1)?.sql, "commit");
});

test("heartbeat and completion require matching running lease and unexpired database time", async () => {
  const { repository, statements } = recordingDatabase(() => ({ affectedRows: 0 }));
  assert.equal(await repository.heartbeat(jobId, leaseToken, "Collecting finalized Base evidence"), false);
  assert.equal(await repository.complete(jobId, leaseToken, report()), false);
  for (const statement of statements) {
    const where = statement.sql.split(" where ")[1];
    assert.match(where, /`status` = \?/);
    assert.match(where, /`lease_token` = \?/);
    assert.match(where, /`lease_expires_at` > UTC_TIMESTAMP\(3\)/);
    assert.ok(statement.values.includes(leaseToken));
  }
  assert.match(statements[1].sql, /JSON_UNQUOTE\(JSON_EXTRACT\(/);
  assert.ok(statements[1].values.includes(token));
});

test("report storage preserves exact aggregate amounts above a single-event uint256", async () => {
  const { repository, statements } = recordingDatabase(() => ({ affectedRows: 1 }));
  const value = report();
  const aggregate = ((1n << 256n) * 2n).toString();
  value.wallets.push({
    address: token, observedIncomingRaw: aggregate, observedOutgoingRaw: "0", observedNetRaw: aggregate,
    balanceRaw: null, verifiedSoldRaw: "0", firstObservedAt: 1, earlyAccumulator: false,
  });
  assert.equal(await repository.complete(jobId, leaseToken, value), true);
  assert.ok(statements[0].values.some((entry) => typeof entry === "string" && entry.includes(aggregate)));
});

test("failure SQL bounds retries, delays requeue, fences stale workers, and redacts upstream errors", async () => {
  const { repository, statements } = recordingDatabase(() => ({ affectedRows: 1 }));
  assert.equal(await repository.fail(jobId, leaseToken, "Provider https://host/?apikey=secret rejected password private"), true);
  const statement = statements[0];
  assert.match(statement.sql, /CASE WHEN.*`attempts` < `investigation_jobs`\.`max_attempts`/);
  assert.match(statement.sql, /LEAST\(300, 30 \* POW\(2,/);
  assert.match(statement.sql, /`lease_expires_at` > UTC_TIMESTAMP\(3\)/);
  assert.equal(statement.values.some((value) => typeof value === "string" && /secret|private/.test(value)), false);
  assert.ok(statement.values.includes("Investigation could not be completed."));
  assert.equal(sanitizeInvestigationError("Data sources were unavailable."), "Data sources were unavailable.");
});

test("malformed parameters, invalid progress, and mismatched reports fail before querying", async () => {
  const { repository, statements } = recordingDatabase();
  await assert.rejects(repository.enqueue({ ...parameters, lookbackBlocks: 20_001 }), InvalidInvestigationJobError);
  await assert.rejects(repository.enqueue({ ...parameters, maxWallets: 51 } as ScanParameters), InvalidInvestigationJobError);
  await assert.rejects(repository.claimNext({ maxAttempts: 4 }), InvalidInvestigationJobError);
  await assert.rejects(repository.heartbeat(jobId, leaseToken, "x".repeat(121)), InvalidInvestigationJobError);
  await assert.rejects(repository.heartbeat(jobId, leaseToken, "stage\nsecret"), InvalidInvestigationJobError);
  await assert.rejects(repository.complete(jobId, leaseToken, { ...report(), id: leaseToken }), InvalidInvestigationJobError);
  const invalid = report();
  invalid.range.from.hash = "0xbad";
  await assert.rejects(repository.complete(jobId, leaseToken, invalid), InvalidInvestigationJobError);
  const invalidAmount = report();
  invalidAmount.token.totalSupplyRaw = "not-a-number";
  await assert.rejects(repository.complete(jobId, leaseToken, invalidAmount), InvalidInvestigationJobError);
  assert.equal(statements.length, 0);
});

test("completion requires valid report-bound model commentary and retained evidence citations", async () => {
  const { repository, statements } = recordingDatabase();
  const missing = report();
  Reflect.deleteProperty(missing, "explanation");
  await assert.rejects(repository.complete(jobId, leaseToken, missing), InvalidInvestigationJobError);
  const mismatch = report();
  mismatch.explanation.reportId = leaseToken;
  await assert.rejects(repository.complete(jobId, leaseToken, mismatch), InvalidInvestigationJobError);
  const invented = report();
  invented.explanation.context = { evidenceIds: ["invented"], suppliedEvidence: 1, omittedEvidence: 0 };
  invented.explanation.overview.evidenceIds = ["invented"];
  await assert.rejects(repository.complete(jobId, leaseToken, invented), InvalidInvestigationJobError);
  const modelMissing = report();
  modelMissing.explanation.model = "";
  await assert.rejects(repository.complete(jobId, leaseToken, modelMissing), InvalidInvestigationJobError);
  assert.equal(statements.length, 0, "invalid commentary must not reach SQL completion");
});

test("database failures never expose driver messages or credentials", async () => {
  const { repository } = recordingDatabase(() => { throw new Error("Access denied: password=secret mysql://private@host/database"); });
  await assert.rejects(repository.get(jobId), (error: unknown) => {
    assert.ok(error instanceof InvestigationRepositoryUnavailableError);
    assert.doesNotMatch(error.message, /secret|mysql:|private@/);
    return true;
  });
});

test("corrupted stored JSON fails safely instead of becoming a fabricated empty report", async () => {
  const malformed = row();
  malformed[2] = "not valid JSON";
  const { repository } = recordingDatabase(() => [malformed]);
  await assert.rejects(repository.get(jobId), InvestigationRepositoryUnavailableError);
});
