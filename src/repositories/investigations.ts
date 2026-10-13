import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { investigationJobs, investigationQueueGuard, investigationScanAdmission, type InvestigationJobRow } from "../db/schema";
import type { ExplainedInvestigationReport, InvestigationJob, ScanParameters } from "../domain/investigations/types";
import { validateExplainedReport } from "../domain/investigations/report-validation";
import { ScanRateLimitError } from "./scan-admission";
export { ScanRateLimitError } from "./scan-admission";

export type TraceforgeDatabase = ReturnType<typeof import("../db/client").getDatabase>;

export interface ClaimOptions {
  leaseSeconds?: number;
  maxAttempts?: number;
}

export interface ClaimedInvestigation {
  job: InvestigationJob;
  leaseToken: string;
}

export interface EnqueueOptions {
  /** Server-derived HMAC identity. Public HTTP entry points must always supply it. */
  clientKey: string;
}

export interface InvestigationRepository {
  enqueue(parameters: ScanParameters, options?: EnqueueOptions): Promise<InvestigationJob>;
  get(id: string): Promise<InvestigationJob | null>;
  claimNext(options?: ClaimOptions): Promise<ClaimedInvestigation | null>;
  heartbeat(id: string, leaseToken: string, stage: string, leaseSeconds?: number): Promise<boolean>;
  complete(id: string, leaseToken: string, report: ExplainedInvestigationReport): Promise<boolean>;
  fail(id: string, leaseToken: string, error: string): Promise<boolean>;
}

export class QueueCapacityError extends Error {
  constructor() {
    super("The investigation queue is full. Try again after existing work completes.");
    this.name = "QueueCapacityError";
  }
}

export class InvestigationRepositoryUnavailableError extends Error {
  constructor() {
    super("Investigation storage is unavailable. Check database configuration and applied migrations.");
    this.name = "InvestigationRepositoryUnavailableError";
  }
}

export class InvalidInvestigationJobError extends Error {
  constructor() {
    super("Invalid investigation parameters, progress, or report.");
    this.name = "InvalidInvestigationJobError";
  }
}

export const INVESTIGATION_QUEUE_CAPACITY = 100;
export const INVESTIGATION_CLIENT_HOURLY_LIMIT = 5;
const DEFAULT_LEASE_SECONDS = 120;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const GENERIC_JOB_ERROR = "Investigation could not be completed.";
const EXPIRED_JOB_ERROR = "The worker lease expired before completion.";
const PUBLIC_ERRORS = new Set([
  GENERIC_JOB_ERROR,
  EXPIRED_JOB_ERROR,
  "Investigation exceeded its processing deadline.",
  "Data sources were unavailable.",
]);

const parametersSchema = z.strictObject({
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as ScanParameters["token"]),
  lookbackBlocks: z.number().int().min(100).max(20_000),
});

/** Only reviewed, static messages can enter the persisted public error field. */
export function sanitizeInvestigationError(error: string): string {
  return PUBLIC_ERRORS.has(error) ? error : GENERIC_JOB_ERROR;
}

function parseParameters(parameters: unknown): ScanParameters {
  const result = parametersSchema.safeParse(decodeJson(parameters));
  if (!result.success) throw new InvalidInvestigationJobError();
  return result.data;
}

function parseReport(report: unknown): ExplainedInvestigationReport {
  try { return validateExplainedReport(decodeJson(report)); }
  catch { throw new InvalidInvestigationJobError(); }
}

/** MariaDB can expose its JSON alias as text while MySQL returns parsed JSON. */
function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    if (Buffer.byteLength(value, "utf8") > MAX_REPORT_BYTES) throw new InvalidInvestigationJobError();
    return JSON.parse(value) as unknown;
  } catch {
    throw new InvalidInvestigationJobError();
  }
}

function validateLease(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 15 || seconds > 900) throw new InvalidInvestigationJobError();
  return seconds;
}

function validateStage(stage: string): string {
  if (typeof stage !== "string" || !/^[A-Za-z0-9 .:_-]{1,120}$/.test(stage) || !stage.trim()) {
    throw new InvalidInvestigationJobError();
  }
  return stage.trim();
}

function validIdentity(id: string): boolean {
  return z.uuid().safeParse(id).success;
}

/** Exported for SQL contract checks; database time is authoritative for ownership. */
export function ownedInvestigationLease(id: string, leaseToken: string): SQL {
  return and(
    eq(investigationJobs.id, id),
    eq(investigationJobs.status, "running"),
    eq(investigationJobs.leaseToken, leaseToken),
    sql`${investigationJobs.leaseExpiresAt} > UTC_TIMESTAMP(3)`,
  )!;
}

function asJob(row: InvestigationJobRow): InvestigationJob {
  try {
    const parameters = parseParameters(row.parameters);
    const report = row.report ? parseReport(row.report) : null;
    if (report && (report.id !== row.id || report.token.address !== parameters.token)) {
      throw new InvalidInvestigationJobError();
    }
    return {
      id: row.id,
      status: row.status,
      parameters,
      stage: row.stage,
      attempts: row.attempts,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      error: row.error ? sanitizeInvestigationError(row.error) : null,
      report,
    };
  } catch {
    throw new InvestigationRepositoryUnavailableError();
  }
}

/**
 * Inject a real Drizzle connection in integration tests. Without injection, import
 * the server-only client lazily on first use; importing this contract opens no DB.
 */
export function createInvestigationRepository(database?: TraceforgeDatabase): InvestigationRepository {
  let resolvedDatabase = database;
  async function run<T>(operation: (db: TraceforgeDatabase) => Promise<T>): Promise<T> {
    try {
      resolvedDatabase ??= (await import("../db/client")).getDatabase();
      return await operation(resolvedDatabase);
    } catch (error) {
      if (error instanceof QueueCapacityError || error instanceof ScanRateLimitError || error instanceof InvalidInvestigationJobError) throw error;
      throw new InvestigationRepositoryUnavailableError();
    }
  }

  return {
    async enqueue(parameters, options) {
      const normalized = parseParameters(parameters);
      const clientKey = options?.clientKey;
      if (options && (typeof clientKey !== "string" || !/^[0-9a-f]{64}$/.test(clientKey))) {
        throw new InvalidInvestigationJobError();
      }
      return run((db) => db.transaction(async (transaction) => {
        // Upsert takes an exclusive row lock held through the count and commit.
        await transaction.insert(investigationQueueGuard).values({ id: 1 }).onDuplicateKeyUpdate({ set: { id: 1 } });
        const [active] = await transaction.select({ value: count() }).from(investigationJobs)
          .where(inArray(investigationJobs.status, ["queued", "running"]));
        if (active.value >= INVESTIGATION_QUEUE_CAPACITY) throw new QueueCapacityError();
        let windowHour: number | undefined;
        if (clientKey) {
          // Capture the DB clock once after obtaining the admission lock. All
          // bucket operations share that hour even if the boundary is crossed.
          const [clock] = await transaction.select({
            windowHour: sql<number>`TIMESTAMPDIFF(HOUR, '1970-01-01 00:00:00', UTC_TIMESTAMP(3))`.mapWith(Number),
            retryAfterSeconds: sql<number>`3600 - MOD(TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)), 3600)`.mapWith(Number),
          }).from(investigationQueueGuard).where(eq(investigationQueueGuard.id, 1));
          if (!clock || !Number.isSafeInteger(clock.windowHour) || clock.windowHour < 0
            || !Number.isInteger(clock.retryAfterSeconds) || clock.retryAfterSeconds < 1 || clock.retryAfterSeconds > 3600) {
            throw new InvestigationRepositoryUnavailableError();
          }
          windowHour = clock.windowHour;
          const [admission] = await transaction.select({ acceptedCount: investigationScanAdmission.acceptedCount })
            .from(investigationScanAdmission).where(and(
              eq(investigationScanAdmission.clientKey, clientKey),
              eq(investigationScanAdmission.windowHour, windowHour),
            ));
          if (admission && admission.acceptedCount >= INVESTIGATION_CLIENT_HOURLY_LIMIT) {
            throw new ScanRateLimitError(clock.retryAfterSeconds);
          }
          // Only admitted clients perform bounded, indexed cleanup. Rejected
          // traffic must not repeatedly delete and roll back expired buckets.
          await transaction.delete(investigationScanAdmission)
            .where(sql`${investigationScanAdmission.expiresAt} <= DATE_ADD('1970-01-01 00:00:00', INTERVAL ${windowHour} HOUR)`)
            .limit(100);
        }
        const id = randomUUID();
        await transaction.insert(investigationJobs).values({
          id, parameters: normalized,
          availableAt: sql`UTC_TIMESTAMP(3)`,
          createdAt: sql`UTC_TIMESTAMP(3)`,
          updatedAt: sql`UTC_TIMESTAMP(3)`,
        });
        if (clientKey && windowHour !== undefined) {
          await transaction.insert(investigationScanAdmission).values({
            clientKey, windowHour, acceptedCount: 1,
            expiresAt: sql`DATE_ADD('1970-01-01 00:00:00', INTERVAL ${windowHour + 1} HOUR)`,
          }).onDuplicateKeyUpdate({
            set: { acceptedCount: sql`${investigationScanAdmission.acceptedCount} + 1` },
          });
        }
        const [row] = await transaction.select().from(investigationJobs).where(eq(investigationJobs.id, id));
        return asJob(row);
      }, { isolationLevel: "read committed" }));
    },

    async get(id) {
      if (!validIdentity(id)) return null;
      return run(async (db) => {
        const [row] = await db.select().from(investigationJobs).where(eq(investigationJobs.id, id)).limit(1);
        return row ? asJob(row) : null;
      });
    },

    async claimNext(options = {}) {
      const leaseSeconds = validateLease(options.leaseSeconds ?? DEFAULT_LEASE_SECONDS);
      const maxAttempts = options.maxAttempts ?? 3;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new InvalidInvestigationJobError();
      return run((db) => db.transaction(async (transaction) => {
        const expired = and(eq(investigationJobs.status, "running"), sql`${investigationJobs.leaseExpiresAt} <= UTC_TIMESTAMP(3)`);
        await transaction.update(investigationJobs).set({
          status: "failed", stage: "failed", error: EXPIRED_JOB_ERROR,
          leaseToken: null, leaseExpiresAt: null, report: null,
          updatedAt: sql`UTC_TIMESTAMP(3)`,
        }).where(and(
          or(expired, eq(investigationJobs.status, "queued")),
          sql`${investigationJobs.attempts} >= LEAST(${investigationJobs.maxAttempts}, ${maxAttempts})`,
        ));

        const eligible = and(
          lt(investigationJobs.attempts, maxAttempts),
          lt(investigationJobs.attempts, investigationJobs.maxAttempts),
          or(
            and(eq(investigationJobs.status, "queued"), sql`${investigationJobs.availableAt} <= UTC_TIMESTAMP(3)`),
            expired,
          ),
        );
        // Blocking FOR UPDATE works on both MySQL and MariaDB without version gates.
        const [row] = await transaction.select().from(investigationJobs).where(eligible)
          .orderBy(asc(investigationJobs.availableAt), asc(investigationJobs.createdAt), asc(investigationJobs.id))
          .limit(1).for("update");
        if (!row) return null;
        const leaseToken = randomUUID();
        await transaction.update(investigationJobs).set({
          status: "running", stage: "starting", error: null,
          attempts: sql`${investigationJobs.attempts} + 1`,
          maxAttempts: Math.min(row.maxAttempts, maxAttempts),
          leaseToken,
          leaseExpiresAt: sql`DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${leaseSeconds} SECOND)`,
          updatedAt: sql`UTC_TIMESTAMP(3)`,
        }).where(and(eq(investigationJobs.id, row.id), eligible));
        const [claimed] = await transaction.select().from(investigationJobs).where(eq(investigationJobs.id, row.id));
        return { job: asJob(claimed), leaseToken };
      }, { isolationLevel: "read committed" }));
    },

    async heartbeat(id, leaseToken, stage, seconds = DEFAULT_LEASE_SECONDS) {
      if (!validIdentity(id) || !validIdentity(leaseToken)) return false;
      const leaseSeconds = validateLease(seconds);
      const normalizedStage = validateStage(stage);
      return run(async (db) => {
        const [result] = await db.update(investigationJobs).set({
          stage: normalizedStage,
          leaseExpiresAt: sql`DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${leaseSeconds} SECOND)`,
          updatedAt: sql`UTC_TIMESTAMP(3)`,
        }).where(ownedInvestigationLease(id, leaseToken));
        return result.affectedRows === 1;
      });
    },

    async complete(id, leaseToken, report) {
      if (!validIdentity(id) || !validIdentity(leaseToken)) return false;
      const normalizedReport = parseReport(report);
      if (normalizedReport.id !== id) throw new InvalidInvestigationJobError();
      return run(async (db) => {
        const [result] = await db.update(investigationJobs).set({
          status: "completed", stage: "completed", report: normalizedReport, error: null,
          leaseToken: null, leaseExpiresAt: null, updatedAt: sql`UTC_TIMESTAMP(3)`,
        }).where(and(
          ownedInvestigationLease(id, leaseToken),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${investigationJobs.parameters}, '$.token')) = ${normalizedReport.token.address}`,
        ));
        return result.affectedRows === 1;
      });
    },

    async fail(id, leaseToken, error) {
      if (!validIdentity(id) || !validIdentity(leaseToken)) return false;
      const safeError = sanitizeInvestigationError(error);
      return run(async (db) => {
        const retry = sql`${investigationJobs.attempts} < ${investigationJobs.maxAttempts}`;
        const [result] = await db.update(investigationJobs).set({
          status: sql`CASE WHEN ${retry} THEN 'queued' ELSE 'failed' END`,
          stage: sql`CASE WHEN ${retry} THEN 'retry queued' ELSE 'failed' END`,
          availableAt: sql`DATE_ADD(UTC_TIMESTAMP(3), INTERVAL LEAST(300, 30 * POW(2, GREATEST(0, ${investigationJobs.attempts} - 1))) SECOND)`,
          error: safeError, report: null,
          leaseToken: null, leaseExpiresAt: null, updatedAt: sql`UTC_TIMESTAMP(3)`,
        }).where(ownedInvestigationLease(id, leaseToken));
        return result.affectedRows === 1;
      });
    },
  };
}
