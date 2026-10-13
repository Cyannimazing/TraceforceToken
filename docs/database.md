# TraceForce Engine database operations

The public application uses MySQL/MariaDB **only for anonymous scan/question burst counters and short-lived active-scan leases**. It does not insert jobs, token parameters, reports, evidence, signed chat capsules, or conversation history. Fresh results travel in the response; optional snapshots stay in the visitor's browser.

Drizzle ORM and mysql2 remain the database layer. Existing traceforge_* names and migrations 0000–0002 are retained for compatibility; migration 0003 adds visitor admission metadata. No archive migration was generated or applied, and no existing application records were deleted.

## Verified local state

On 2026-10-12, migrations 0000_traceforge_foundation, 0001_durable_investigation_jobs, 0002_public_scan_admission, and 0003_visitor_admission were explicitly applied to XAMPP MariaDB 10.4.32 databases traceforge_local and traceforge_test_jobs.

The local runtime account has database-scoped SELECT/INSERT/UPDATE/DELETE, without global or schema-changing privileges. The migration account and disposable test account are separate; credentials live in ignored .env.local. These are local facts, not hosted grant/TLS verification.

Eighteen genuine integration tests passed: ten legacy queue/admission compatibility tests and eight new visitor-admission tests. The new tests cover concurrent 30-request limits, visitor isolation, one active scan per visitor, stale-release protection, counter-window reset with an active lease, bounded cleanup, independent row locks, and the exact 330-second DB-clock lease. They also verify that the admission row contains no request content. Integration tests reset only an explicitly configured local traceforge_test_* database; the visitor suite resets only its visitor_admission table. No live application-data deletion is part of that test run.

## Current admission operations

src/repositories/visitor-admission.ts exports:

    createVisitorAdmissionRepository(database?)
      .consumeRequest(visitorKey)
      -> Promise<{ retryAfterSeconds: number }>
      .acquireScan(visitorKey)
      -> Promise<{ token: string; release(): Promise<void> }>

Scan and question HTTP boundaries share **30 requests per 30 seconds per visitor**. A signed, expiring browser visitor cookie supplies the server-derived lowercase 64-hex HMAC key; the database stores neither the cookie nor a raw IP. This identity grants no report access and is not an account or proof of a person. API requests do not mint replacement visitor cookies. Local visitors receive independent keys rather than sharing one local bucket.

Each operation uses a READ COMMITTED transaction and locks only that visitor's primary-key row. There is no singleton serialization lock in the current path. The repository captures database UTC time after obtaining the row lock; the counter resets when that visitor's 30-second window has elapsed. A rejected burst transaction rolls back without incrementing its counter. A successfully consumed request can still count when later input validation, scan acquisition or execution fails.

Scan acquisition is independent of the burst count and permits **one active scan per visitor**, across application instances. It stores a random lease token and an expiry exactly 330 seconds after the locked row's DB clock. An active lease rejects a second scan; an expired lease can be replaced. Counter-window reset preserves a still-active lease.

The streaming scan wrapper releases its lease on completion, failure, cancellation or its execution deadline. Release updates only the row whose visitor key and lease token both match, so a repeated release or stale callback cannot clear a replacement lease. If the process crashes or release fails, the lease remains bounded by its expiry; there is no permanent active lock.

After a successful counter or lease transaction commits, cleanup discovers at most 20 expired visitor rows without locking them, then deletes candidates individually in autocommit operations. Each delete rechecks expiry and preserves a live lease. Cleanup does not hold the admitted visitor's transaction lock, and a cleanup failure does not undo successful admission. Cleanup is opportunistic on admitted traffic; idle rows are not removed by an automatic schedule.

Only visitor_admission is read or written by this public admission path. Its fields are the opaque visitor key, window start, request count, lease token, lease expiry and row expiry. There are no job-table reads, queue-capacity counts, token parameters, reports, evidence or chat-history writes. Malformed keys are rejected before database use, and repository failures expose static errors instead of driver messages.

## Historical five-per-hour admission (legacy/tests only)

src/repositories/scan-admission.ts remains for compatibility tests; public scan and question routes no longer call it. Its historical interface is:

    createScanAdmissionRepository(database?)
      .reserveScan(clientKey)
      -> Promise<{ retryAfterSeconds: number }>

The legacy client key must be a server-derived lowercase 64-hex HMAC. This repository rejects raw IPs/malformed keys before database use and exposes static errors instead of driver messages.

Within one READ COMMITTED transaction it:

1. Upserts the ID=1 guard row, taking an exclusive lock.
2. Captures DB UTC hour/reset once and reads that client's counter.
3. Rejects count five with ScanRateLimitError and safe 1–3,600 retry seconds.
4. Deletes at most 100 expired buckets using the indexed expiry field.
5. Inserts/increments the accepted count and commits.

It reads/writes only investigation_queue_guard and investigation_scan_admission. There are no job-table reads, queue-capacity counts, or report/evidence writes in this legacy path. The retired public policy used separate purpose keys for scan and question requests, with five-per-hour limits and a shared local bucket per purpose. These are historical behavior and test coverage, not the current public limits.

Legacy hours use database UTC rather than application clocks. Rejected reservations roll back without cleanup or increment. Execution failures after a successful reservation can consume it. The legacy cleanup is bounded to 100 expired buckets within the guarded transaction.

## Schema compatibility

| Table | Current public use |
| --- | --- |
| visitor_admission | Current combined visitor burst counter and active-scan lease; count CHECK 0–30; expiry index and per-visitor row lock |
| investigation_queue_guard | Historical singleton lock; legacy repositories/tests only |
| investigation_scan_admission | Historical opaque client/hour/count/expiry; count CHECK 1–5; legacy repositories/tests only |
| investigation_jobs | Legacy durable repository/tests only; no public enqueue/read |
| investigations | Retained baseline schema; not populated by the public engine |
| investigation_evidence | Retained baseline schema; not populated by the public engine |

Old saved-ID APIs and the private durable worker route return 410. The old CLI exits with a retirement message. Existing rows remain for operator-managed compatibility; this change neither exposes them through public history nor silently removes them.

Legacy report JSON still validates with the shared domain boundary, including required explanation/citations and exact amount strings. This compatibility does not authorize restoring persistence to the public path. A future schema reduction needs a reviewed explicit migration and a separate decision about existing data.

## Configure connections safely

    DATABASE_URL=mysql://user:percent_encoded_password@host:3306/traceforge
    DATABASE_SSL=true
    DATABASE_POOL_SIZE=5

The parser requires a database name and rejects embedded query options/invalid settings. Tooling loads .env.local then .env without overwriting injected values. Missing configuration fails only when a DB operation is attempted; import/build opens no connection.

Remote hosts default to verified TLS; DATABASE_SSL=false is rejected remotely. Trust-chain and hostname verification stay enabled. DATABASE_CA_CERT optionally supplies a trusted PEM CA. Local loopback can explicitly use plaintext; any remote tunnel must itself be secured. If a host cannot support verified remote TLS, use a secure tunnel/data layer or a TLS-capable host, not certificate bypasses. [MySQL encrypted connections](https://dev.mysql.com/doc/refman/8.4/en/using-encrypted-connections.html)

The server-only lazy pool defaults to five connections per process, bounds waiting, and uses Vercel's idle-pool hook. Size total connections across instances. The VPS scan engine needs **no database credentials**; only the Next.js quota boundary connects in the split deployment.

## Explicit migrations and host moves

    npm run db:generate -- --name=describe_the_change
    npm run db:check
    npm run db:migrate
    npm run db:migrate:test

Generate/review SQL, snapshot, and journal together. db:check inspects history without applying SQL. db:migrate prefers DATABASE_MIGRATION_URL, otherwise DATABASE_URL. Test mode requires TEST_DATABASE_URL pointing to a local traceforge_test_* database. Studio is an explicit local operator command. [Drizzle migration workflows](https://orm.drizzle.team/docs/migrations)

The runner uses a dedicated connection and database-specific advisory lock, waiting at most 30 seconds. Lock failure applies no SQL. Cleanup releases the lock and closes the session; after a crash the server releases it when disconnection is detected. MySQL DDL can commit implicitly, so a lock is neither rollback nor backup. Migrations never run at installation, build, startup, request, or test time.

Changing DATABASE_URL selects a host; migrations create/update schema, not copy existing data. If legacy data must move, use deliberate database export/import and verify restore separately. Do not invent a data migration by merely switching credentials. Backup/retention decisions for existing legacy data remain operator work; no new report history, pruning schedule, or archival policy is introduced.
