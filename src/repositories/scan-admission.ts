import { and, eq, sql } from "drizzle-orm";
import { investigationQueueGuard, investigationScanAdmission } from "../db/schema";

type AdmissionDatabase = ReturnType<typeof import("../db/client").getDatabase>;

export const SCAN_CLIENT_HOURLY_LIMIT = 5;

export interface ScanAdmissionRepository {
  /** Reserve anonymous quota only. No parameters, evidence, report, or job is stored. */
  reserveScan(clientKey: string): Promise<{ retryAfterSeconds: number }>;
}

export class ScanRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("The free scan limit is five accepted investigations per UTC hour. Try again after the limit resets.");
    this.name = "ScanRateLimitError";
    this.retryAfterSeconds = Number.isFinite(retryAfterSeconds)
      ? Math.max(1, Math.min(3600, Math.ceil(retryAfterSeconds))) : 3600;
  }
}

export class InvalidScanClientKeyError extends Error {
  constructor() { super("Invalid scan admission identity."); this.name = "InvalidScanClientKeyError"; }
}

export class ScanAdmissionUnavailableError extends Error {
  constructor() { super("Scan admission is unavailable. Check database configuration and applied migrations."); this.name = "ScanAdmissionUnavailableError"; }
}

/** Lazy DB access; production uses the server-only client, tests inject real Drizzle. */
export function createScanAdmissionRepository(database?: AdmissionDatabase): ScanAdmissionRepository {
  let resolvedDatabase = database;
  return {
    async reserveScan(clientKey) {
      // Public callers supply a server-derived HMAC, never an IP or browser identity.
      if (typeof clientKey !== "string" || !/^[0-9a-f]{64}$/.test(clientKey)) throw new InvalidScanClientKeyError();
      try {
        resolvedDatabase ??= (await import("../db/client")).getDatabase();
        return await resolvedDatabase.transaction(async (transaction) => {
          // This singleton upsert takes an exclusive lock until commit/rollback.
          await transaction.insert(investigationQueueGuard).values({ id: 1 }).onDuplicateKeyUpdate({ set: { id: 1 } });
          const [clock] = await transaction.select({
            windowHour: sql<number>`TIMESTAMPDIFF(HOUR, '1970-01-01 00:00:00', UTC_TIMESTAMP(3))`.mapWith(Number),
            retryAfterSeconds: sql<number>`3600 - MOD(TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)), 3600)`.mapWith(Number),
          }).from(investigationQueueGuard).where(eq(investigationQueueGuard.id, 1));
          if (!clock || !Number.isSafeInteger(clock.windowHour) || clock.windowHour < 0
            || !Number.isInteger(clock.retryAfterSeconds) || clock.retryAfterSeconds < 1 || clock.retryAfterSeconds > 3600) throw new ScanAdmissionUnavailableError();
          const [admission] = await transaction.select({ acceptedCount: investigationScanAdmission.acceptedCount })
            .from(investigationScanAdmission).where(and(
              eq(investigationScanAdmission.clientKey, clientKey),
              eq(investigationScanAdmission.windowHour, clock.windowHour),
            ));
          if (admission && (!Number.isInteger(admission.acceptedCount) || admission.acceptedCount < 1 || admission.acceptedCount > SCAN_CLIENT_HOURLY_LIMIT)) throw new ScanAdmissionUnavailableError();
          if (admission && admission.acceptedCount >= SCAN_CLIENT_HOURLY_LIMIT) throw new ScanRateLimitError(clock.retryAfterSeconds);
          // Rejected requests do not do cleanup writes or consume another quota unit.
          await transaction.delete(investigationScanAdmission)
            .where(sql`${investigationScanAdmission.expiresAt} <= DATE_ADD('1970-01-01 00:00:00', INTERVAL ${clock.windowHour} HOUR)`)
            .limit(100);
          await transaction.insert(investigationScanAdmission).values({
            clientKey, windowHour: clock.windowHour, acceptedCount: 1,
            expiresAt: sql`DATE_ADD('1970-01-01 00:00:00', INTERVAL ${clock.windowHour + 1} HOUR)`,
          }).onDuplicateKeyUpdate({ set: { acceptedCount: sql`${investigationScanAdmission.acceptedCount} + 1` } });
          return { retryAfterSeconds: clock.retryAfterSeconds };
        }, { isolationLevel: "read committed" });
      } catch (error) {
        if (error instanceof ScanRateLimitError || error instanceof ScanAdmissionUnavailableError) throw error;
        throw new ScanAdmissionUnavailableError();
      }
    },
  };
}
