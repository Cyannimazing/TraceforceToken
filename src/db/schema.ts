import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import type { CanonicalAddress } from "./values";
import type { InvestigationReport, ScanParameters } from "../domain/investigations/types";

export interface InvestigationCoverage {
  fromBlock?: string;
  toBlock?: string;
  complete: boolean;
  warnings: string[];
}

export interface EvidenceProvenance {
  provider: string;
  method: string;
  observedAt: string;
  sourceUrl?: string;
  historyComplete?: boolean;
}

/** Foundation records only. No collector or job runner is wired to these tables. */
export const investigations = mysqlTable(
  "investigations",
  {
    id: char("id", { length: 36 }).primaryKey(),
    chain: mysqlEnum("chain", ["base"]).notNull().default("base"),
    chainId: int("chain_id", { unsigned: true }).notNull().default(8453),
    tokenAddress: char("token_address", { length: 42 }).$type<CanonicalAddress>().notNull(),
    tokenName: varchar("token_name", { length: 255 }),
    tokenSymbol: varchar("token_symbol", { length: 64 }),
    tokenDecimals: int("token_decimals", { unsigned: true }),
    totalSupplyRaw: varchar("total_supply_raw", { length: 78 }),
    status: mysqlEnum("status", ["draft", "collecting", "completed", "failed"])
      .notNull()
      .default("draft"),
    coverage: json("coverage").$type<InvestigationCoverage>(),
    provenance: json("provenance").$type<EvidenceProvenance[]>(),
    summary: text("summary"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("investigations_chain_token_created_idx").on(table.chain, table.tokenAddress, table.createdAt),
    index("investigations_status_created_idx").on(table.status, table.createdAt),
    check("investigations_base_chain_id_chk", sql`${table.chainId} = 8453`),
    check("investigations_token_address_chk", sql`${table.tokenAddress} REGEXP '^0x[0-9a-f]{40}$' AND CAST(${table.tokenAddress} AS BINARY) = CAST(LOWER(${table.tokenAddress}) AS BINARY)`),
    check("investigations_token_decimals_chk", sql`${table.tokenDecimals} IS NULL OR ${table.tokenDecimals} <= 255`),
    check(
      "investigations_total_supply_raw_chk",
      sql`${table.totalSupplyRaw} IS NULL OR (${table.totalSupplyRaw} REGEXP '^(0|[1-9][0-9]{0,77})$' AND (CHAR_LENGTH(${table.totalSupplyRaw}) < 78 OR ${table.totalSupplyRaw} <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'))`,
    ),
  ],
);

export const investigationEvidence = mysqlTable(
  "investigation_evidence",
  {
    id: char("id", { length: 36 }).primaryKey(),
    investigationId: char("investigation_id", { length: 36 })
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade", onUpdate: "restrict" }),
    kind: mysqlEnum("kind", ["funding", "transfer", "swap", "contract", "metadata"]).notNull(),
    /** Stable provider/event identity, scoped to one investigation. */
    sourceEventId: varchar("source_event_id", { length: 191 }).notNull(),
    transactionHash: char("transaction_hash", { length: 66 }),
    blockNumber: bigint("block_number", { mode: "bigint", unsigned: true }),
    logIndex: int("log_index", { unsigned: true }),
    observedAt: datetime("observed_at", { mode: "date", fsp: 3 }).notNull(),
    fromAddress: char("from_address", { length: 42 }).$type<CanonicalAddress>(),
    toAddress: char("to_address", { length: 42 }).$type<CanonicalAddress>(),
    assetAddress: char("asset_address", { length: 42 }).$type<CanonicalAddress>(),
    assetSymbol: varchar("asset_symbol", { length: 64 }),
    amountRaw: varchar("amount_raw", { length: 78 }),
    description: text("description").notNull(),
    provenance: json("provenance").$type<EvidenceProvenance>().notNull(),
    details: json("details").$type<Record<string, unknown>>(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("evidence_investigation_source_uidx").on(table.investigationId, table.sourceEventId),
    index("evidence_investigation_observed_idx").on(table.investigationId, table.observedAt),
    index("evidence_transaction_hash_idx").on(table.transactionHash),
    index("evidence_from_address_idx").on(table.fromAddress),
    index("evidence_to_address_idx").on(table.toAddress),
    check("evidence_transaction_hash_chk", sql`${table.transactionHash} IS NULL OR (${table.transactionHash} REGEXP '^0x[0-9a-f]{64}$' AND CAST(${table.transactionHash} AS BINARY) = CAST(LOWER(${table.transactionHash}) AS BINARY))`),
    check("evidence_from_address_chk", sql`${table.fromAddress} IS NULL OR (${table.fromAddress} REGEXP '^0x[0-9a-f]{40}$' AND CAST(${table.fromAddress} AS BINARY) = CAST(LOWER(${table.fromAddress}) AS BINARY))`),
    check("evidence_to_address_chk", sql`${table.toAddress} IS NULL OR (${table.toAddress} REGEXP '^0x[0-9a-f]{40}$' AND CAST(${table.toAddress} AS BINARY) = CAST(LOWER(${table.toAddress}) AS BINARY))`),
    check("evidence_asset_address_chk", sql`${table.assetAddress} IS NULL OR (${table.assetAddress} REGEXP '^0x[0-9a-f]{40}$' AND CAST(${table.assetAddress} AS BINARY) = CAST(LOWER(${table.assetAddress}) AS BINARY))`),
    check(
      "evidence_amount_raw_chk",
      sql`${table.amountRaw} IS NULL OR (${table.amountRaw} REGEXP '^(0|[1-9][0-9]{0,77})$' AND (CHAR_LENGTH(${table.amountRaw}) < 78 OR ${table.amountRaw} <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'))`,
    ),
  ],
);

export type Investigation = typeof investigations.$inferSelect;
export type NewInvestigation = typeof investigations.$inferInsert;
export type InvestigationEvidence = typeof investigationEvidence.$inferSelect;
export type NewInvestigationEvidence = typeof investigationEvidence.$inferInsert;

/** The live worker persists its complete versioned report here atomically. */
export const investigationJobs = mysqlTable(
  "investigation_jobs",
  {
    id: char("id", { length: 36 }).primaryKey(),
    status: mysqlEnum("status", ["queued", "running", "completed", "failed"])
      .notNull()
      .default("queued"),
    parameters: json("parameters").$type<ScanParameters>().notNull(),
    stage: varchar("stage", { length: 120 }).notNull().default("queued"),
    attempts: int("attempts", { unsigned: true }).notNull().default(0),
    maxAttempts: int("max_attempts", { unsigned: true }).notNull().default(3),
    availableAt: datetime("available_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    leaseToken: char("lease_token", { length: 36 }),
    leaseExpiresAt: datetime("lease_expires_at", { mode: "date", fsp: 3 }),
    report: json("report").$type<InvestigationReport>(),
    error: varchar("error", { length: 255 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("investigation_jobs_queue_idx").on(table.status, table.availableAt, table.createdAt),
    index("investigation_jobs_recovery_idx").on(table.status, table.leaseExpiresAt),
    check("investigation_jobs_attempts_chk", sql`${table.attempts} <= 3 AND ${table.maxAttempts} BETWEEN 1 AND 3`),
    check(
      "investigation_jobs_lease_chk",
      sql`(${table.status} = 'running' AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
    check("investigation_jobs_report_chk", sql`(${table.status} = 'completed' AND ${table.report} IS NOT NULL) OR (${table.status} <> 'completed' AND ${table.report} IS NULL)`),
  ],
);

/** One transactionally locked row serializes active-capacity reservations. */
export const investigationQueueGuard = mysqlTable(
  "investigation_queue_guard",
  { id: int("id", { unsigned: true }).primaryKey() },
  (table) => [check("investigation_queue_guard_singleton_chk", sql`${table.id} = 1`)],
);

/** Opaque client keys only; fixed UTC-hour admission counters, never raw IPs. */
export const investigationScanAdmission = mysqlTable(
  "investigation_scan_admission",
  {
    clientKey: char("client_key", { length: 64 }).notNull(),
    windowHour: int("window_hour", { unsigned: true }).notNull(),
    acceptedCount: int("accepted_count", { unsigned: true }).notNull().default(1),
    expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientKey, table.windowHour] }),
    index("investigation_scan_admission_expiry_idx").on(table.expiresAt),
    check("investigation_scan_admission_key_chk", sql`${table.clientKey} REGEXP '^[0-9a-f]{64}$' AND CAST(${table.clientKey} AS BINARY) = CAST(LOWER(${table.clientKey}) AS BINARY)`),
    check("investigation_scan_admission_count_chk", sql`${table.acceptedCount} BETWEEN 1 AND 5`),
  ],
);

export type InvestigationJobRow = typeof investigationJobs.$inferSelect;

/** Anonymous burst counters and active-scan leases only; one independently locked visitor row. */
export const visitorAdmission = mysqlTable(
  "visitor_admission",
  {
    visitorKey: char("visitor_key", { length: 64 }).primaryKey(),
    windowStartedAt: datetime("window_started_at", { mode: "date", fsp: 3 }).notNull(),
    requestCount: int("request_count", { unsigned: true }).notNull().default(0),
    leaseToken: char("lease_token", { length: 36 }),
    leaseExpiresAt: datetime("lease_expires_at", { mode: "date", fsp: 3 }),
    expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => [
    index("visitor_admission_expiry_idx").on(table.expiresAt),
    check("visitor_admission_key_chk", sql`${table.visitorKey} REGEXP '^[0-9a-f]{64}$' AND CAST(${table.visitorKey} AS BINARY) = CAST(LOWER(${table.visitorKey}) AS BINARY)`),
    check("visitor_admission_count_chk", sql`${table.requestCount} BETWEEN 0 AND 30`),
    check("visitor_admission_lease_chk", sql`(${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.expiresAt} >= ${table.leaseExpiresAt})`),
  ],
);
