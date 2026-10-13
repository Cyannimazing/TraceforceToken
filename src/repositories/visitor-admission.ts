import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { visitorAdmission } from "../db/schema";

type AdmissionDatabase = ReturnType<typeof import("../db/client").getDatabase>;
type AdmissionTransaction = Parameters<Parameters<AdmissionDatabase["transaction"]>[0]>[0];

export const VISITOR_BURST_LIMIT = 30;
export const VISITOR_BURST_WINDOW_SECONDS = 30;
export const VISITOR_SCAN_LEASE_SECONDS = 330;
const WINDOW_MILLISECONDS = VISITOR_BURST_WINDOW_SECONDS * 1000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function retrySeconds(value: number, maximum: number) {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.ceil(value))) : maximum;
}

export class VisitorRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("Too many requests. Please wait briefly and try again.");
    this.name = "VisitorRateLimitError";
    this.retryAfterSeconds = retrySeconds(retryAfterSeconds, VISITOR_BURST_WINDOW_SECONDS);
  }
}

export class VisitorScanActiveError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("An investigation is already running in this browser. Wait for it to finish or cancel it before starting another.");
    this.name = "VisitorScanActiveError";
    this.retryAfterSeconds = retrySeconds(retryAfterSeconds, VISITOR_SCAN_LEASE_SECONDS);
  }
}

export class VisitorAdmissionUnavailableError extends Error {
  constructor() {
    super("Request admission is unavailable. Check database configuration and applied migrations.");
    this.name = "VisitorAdmissionUnavailableError";
  }
}

export class InvalidVisitorKeyError extends Error {
  constructor() { super("Invalid visitor admission identity."); this.name = "InvalidVisitorKeyError"; }
}

export interface VisitorAdmissionRepository {
  /** Shared scan/question burst counter. No request content is retained. */
  consumeRequest(visitorKey: string): Promise<{ retryAfterSeconds: number }>;
  /** One distributed scan lease, independent of the burst request count. */
  acquireScan(visitorKey: string): Promise<{ token: string; release(): Promise<void> }>;
}

function validateKey(key: string) {
  if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) throw new InvalidVisitorKeyError();
}

function timestamp(milliseconds: number) {
  // Derived only from the locked row's DB UTC clock, never the application clock.
  return new Date(milliseconds);
}

async function lockVisitor(transaction: AdmissionTransaction, visitorKey: string) {
  // The unique visitor primary key is the lock. Different visitors share no singleton mutex.
  await transaction.insert(visitorAdmission).values({
    visitorKey, windowStartedAt: sql`UTC_TIMESTAMP(3)`, requestCount: 0, expiresAt: sql`UTC_TIMESTAMP(3)`,
  }).onDuplicateKeyUpdate({ set: { visitorKey } });
  // Capture time after acquiring the row, so a blocked request cannot reuse an old clock.
  const [row] = await transaction.select({
    windowStartedMilliseconds: sql<number>`TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', ${visitorAdmission.windowStartedAt}) DIV 1000`.mapWith(Number),
    requestCount: visitorAdmission.requestCount,
    leaseToken: visitorAdmission.leaseToken,
    nowMilliseconds: sql<number>`TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000`.mapWith(Number),
    leaseExpiresMilliseconds: sql<number | null>`TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', ${visitorAdmission.leaseExpiresAt}) DIV 1000`.mapWith({ mapFromDriverValue: (value: unknown) => value === null ? null : Number(value) }),
  }).from(visitorAdmission).where(eq(visitorAdmission.visitorKey, visitorKey)).for("update");
  if (!row || !Number.isSafeInteger(row.nowMilliseconds) || row.nowMilliseconds < 0
    || !Number.isSafeInteger(row.windowStartedMilliseconds) || row.windowStartedMilliseconds < 0 || row.windowStartedMilliseconds > row.nowMilliseconds
    || !Number.isInteger(row.requestCount) || row.requestCount < 0 || row.requestCount > VISITOR_BURST_LIMIT
    || (row.leaseToken === null) !== (row.leaseExpiresMilliseconds === null)
    || (row.leaseToken !== null && (!uuidPattern.test(row.leaseToken)
      || !Number.isSafeInteger(row.leaseExpiresMilliseconds) || row.leaseExpiresMilliseconds! < 0
      || row.leaseExpiresMilliseconds! > row.nowMilliseconds + VISITOR_SCAN_LEASE_SECONDS * 1000))) {
    throw new VisitorAdmissionUnavailableError();
  }
  return row;
}

/** Lazy server-only access; tests can inject a genuine Drizzle database. */
export function createVisitorAdmissionRepository(database?: AdmissionDatabase): VisitorAdmissionRepository {
  let resolvedDatabase = database;
  const resolveDatabase = async () => resolvedDatabase ??= (await import("../db/client")).getDatabase();
  const unavailable = (error: unknown): never => {
    if (error instanceof VisitorRateLimitError || error instanceof VisitorScanActiveError || error instanceof VisitorAdmissionUnavailableError) throw error;
    throw new VisitorAdmissionUnavailableError();
  };
  const cleanupExpired = async (connection: AdmissionDatabase) => {
    // Outside the visitor transaction: housekeeping cannot hold a visitor's lock
    // while acquiring other rows. Expired counters never remove a live lease.
    try {
      const expired = () => and(
        lte(visitorAdmission.expiresAt, sql`UTC_TIMESTAMP(3)`),
        or(isNull(visitorAdmission.leaseExpiresAt), lte(visitorAdmission.leaseExpiresAt, sql`UTC_TIMESTAMP(3)`)),
      );
      const candidates = await connection.select({ visitorKey: visitorAdmission.visitorKey })
        .from(visitorAdmission).where(expired()).limit(20);
      // Nonlocking bounded discovery, then one primary-key delete per autocommit.
      // No cleanup transaction holds one visitor while waiting for another.
      for (const candidate of candidates) await connection.delete(visitorAdmission)
        .where(and(eq(visitorAdmission.visitorKey, candidate.visitorKey), expired())).limit(1);
    } catch {
      // Admission/lease already committed. Housekeeping failure cannot turn an
      // unadmitted request into success or invalidate its successfully stored lease.
    }
  };
  return {
    async consumeRequest(visitorKey) {
      validateKey(visitorKey);
      try {
        const connection = await resolveDatabase();
        const result = await connection.transaction(async (transaction) => {
          const row = await lockVisitor(transaction, visitorKey);
          const windowStart = row.nowMilliseconds - row.windowStartedMilliseconds >= WINDOW_MILLISECONDS
            ? row.nowMilliseconds : row.windowStartedMilliseconds;
          const windowEnd = windowStart + WINDOW_MILLISECONDS;
          const retryAfterSeconds = retrySeconds((windowEnd - row.nowMilliseconds) / 1000, VISITOR_BURST_WINDOW_SECONDS);
          const requestCount = windowStart === row.windowStartedMilliseconds ? row.requestCount : 0;
          if (requestCount >= VISITOR_BURST_LIMIT) throw new VisitorRateLimitError(retryAfterSeconds);
          await transaction.update(visitorAdmission).set({
            windowStartedAt: timestamp(windowStart), requestCount: requestCount + 1,
            expiresAt: timestamp(Math.max(windowEnd, row.leaseExpiresMilliseconds ?? 0)),
          }).where(eq(visitorAdmission.visitorKey, visitorKey));
          return { retryAfterSeconds };
        }, { isolationLevel: "read committed" });
        await cleanupExpired(connection);
        return result;
      } catch (error) { return unavailable(error); }
    },
    async acquireScan(visitorKey) {
      validateKey(visitorKey);
      try {
        const connection = await resolveDatabase();
        const token = randomUUID();
        await connection.transaction(async (transaction) => {
          const row = await lockVisitor(transaction, visitorKey);
          if (row.leaseExpiresMilliseconds !== null && row.leaseExpiresMilliseconds > row.nowMilliseconds) {
            throw new VisitorScanActiveError((row.leaseExpiresMilliseconds - row.nowMilliseconds) / 1000);
          }
          const leaseExpiresMilliseconds = row.nowMilliseconds + VISITOR_SCAN_LEASE_SECONDS * 1000;
          const windowEnd = row.windowStartedMilliseconds + WINDOW_MILLISECONDS;
          await transaction.update(visitorAdmission).set({
            leaseToken: token, leaseExpiresAt: timestamp(leaseExpiresMilliseconds),
            expiresAt: timestamp(Math.max(windowEnd, leaseExpiresMilliseconds)),
          }).where(eq(visitorAdmission.visitorKey, visitorKey));
        }, { isolationLevel: "read committed" });
        await cleanupExpired(connection);
        return { token, async release() {
          try {
            // Conditional release is safe to repeat, and an expired lease's old
            // callback cannot clear a replacement acquired by another process.
            await connection.update(visitorAdmission).set({
              leaseToken: null, leaseExpiresAt: null,
              expiresAt: sql`GREATEST(UTC_TIMESTAMP(3), DATE_ADD(${visitorAdmission.windowStartedAt}, INTERVAL ${VISITOR_BURST_WINDOW_SECONDS} SECOND))`,
            }).where(and(eq(visitorAdmission.visitorKey, visitorKey), eq(visitorAdmission.leaseToken, token)));
          } catch (error) { return unavailable(error); }
        } };
      } catch (error) { return unavailable(error); }
    },
  };
}
