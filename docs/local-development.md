# Running TraceForce Engine locally with XAMPP

Next.js, strict TypeScript and Tailwind 4 run as a Node application. XAMPP supplies only its MySQL-compatible MariaDB service; Apache is not used. MySQL holds anonymous burst-admission counters, transaction guards and temporary active-scan leases. **The current scan path does not write token parameters, jobs, evidence, reports, signed chat context or conversations to the server database or disk.** The configured AI provider performs the required main review and each accepted current-page question; signed facts and complete proofs constrain substantive answers.

## Local setup

Start MySQL in the XAMPP control panel, then run:

```powershell
npm.cmd ci
npm.cmd run db:setup:local
npm.cmd run db:migrate
npm.cmd run db:migrate:test
```

Setup connects only to 127.0.0.1:3306 and creates traceforge_local plus the disposable traceforge_test_jobs database, with separate runtime, migration and test accounts. These existing database names remain after rebranding. Runtime credentials have SELECT/INSERT/UPDATE/DELETE access without schema-changing privileges. Random credentials and RATE_LIMIT_SECRET are saved to ignored .env.local without printing them. Existing configuration outside the fixed local names makes setup refuse to proceed.

If XAMPP uses another port or admin credentials, set LOCAL_MYSQL_PORT, LOCAL_MYSQL_ADMIN_USER and/or LOCAL_MYSQL_ADMIN_PASSWORD in the shell first. Setup does not change XAMPP's root account, global configuration, service or other databases. Normal development uses the dedicated runtime account. Local setup selects DATABASE_SSL=false; remote connections require verified TLS. Migrations remain explicit and never run at build, startup or request time.

The existing migrations retain earlier prototype tables for compatibility. The current request path only updates anonymous admission counters and temporary active-scan leases. Retiring history writes does not automatically delete existing development records from the earlier prototype. The separate integration database is disposable; do not point test commands at application or production data. Local MariaDB 10.4.32 compatibility has been checked; it is not evidence of a tested Hostinger database deployment.

## Start the model and application

Follow [the local AI guide](local-ai.md) to run private Ollama, install the reviewed qwen3:4b-instruct-2507-q4_K_M base when missing, and create traceforce-investigator with profile 1.6.0. Model downloads/setup are explicit operator actions. For local-only inference, set `INVESTIGATOR_AI_PROVIDER=local`, `LOCAL_AI_MODEL=traceforce-investigator` and the running loopback `LOCAL_AI_BASE_URL` in `.env.local`. This selection needs no external AI key and does not call configured cloud providers. Restart execution after changing settings.

```powershell
npm.cmd run ai:serve
# After the reviewed base is installed:
npm.cmd run ai:setup

# Run Next.js in another terminal:
npm.cmd run dev
```

Open http://localhost:3000/investigate. Enter a Base ERC-20 contract; full history from block 0 through the pinned finalized block is the default. Scan settings can explicitly select a recent 100–20,000-block window. There is no 50-wallet count ceiling. All discovered participants are eligible; provider/time/budget gaps remain explicit. No sign-in, wallet connection, ownership or payment is required. Every submission streams fresh acquisition, findings and a required AI explanation. The report has no server recovery URL. Closing the tab, cancelling, restarting or losing the connection can lose active work; a new submission crawls again. Full scope describes the requested range, not a promise that provider limits permit completion.

**Do not run worker:once or worker:poll.** These legacy commands are retired and fail immediately rather than processing saved jobs. The former job-status and internal-worker endpoints return 410. There is no job polling, durable background queue or automatic retry. Execution capacity is process-local: one process admits three active operations sharing one AI inference slot. This protects finite engine resources independently of each visitor's burst counter and active-scan lease. Waiting for AI counts toward the scan's 270-second deadline. Excess work can receive 429.

Local Next.js executes collection/inference directly when SCAN_ENGINE_URL is absent. The separate engine is optional for local development. On Vercel, configure the protected HTTPS VPS engine URL and its server-only SCAN_ENGINE_SECRET; missing remote configuration fails closed. The standalone engine loads only process environment, requires its own secret/provider/AI configuration and binds loopback. It has no database dependency. See [the prepared VPS runbook](../deploy/linux/README.md); its systemd/nginx templates have not been deployed or tested on Hostinger.

## What is stored

Fresh reports stay in React/page memory. **Save in this browser** explicitly stores a validated report snapshot in IndexedDB, up to five reports and 20 MiB total, evicting the least recently opened snapshots when necessary. Opening one displays a labeled historical snapshot without making a new network scan. Snapshots can be removed individually or cleared together; browser cleanup/private browsing may remove them. Storage failure leaves the current result usable.

There is no report autosave. IndexedDB snapshots and **Download JSON** include only the report, never the signed question context or transcript. Opening a saved snapshot requires a fresh scan before questions become available. Clearing the current report does not remove separately saved browser snapshots.

Current-page questions use the report's short-lived signed context, expiring after 30 minutes. Answers cite existing evidence and indicate when another fresh scan is needed. Each request sends its current question, signed context and at most six recent messages as untrusted conversational context; the transcript remains in page memory, with at most 20 visible messages. Questions do not acquire new chain evidence or establish current balances, ownership or intent.

The public API allows a combined burst of **30 requests per visitor in 30 seconds** across scans and questions, with **one active scan per visitor**. There is no hourly scan or question quota. Page navigation creates a signed, host-only, HttpOnly, SameSite=Strict visitor cookie; HTTPS also sets Secure. Tabs in one browser context share the identity, while separate contexts are independent even on localhost. Raw IPs, cookie values and token parameters are not stored in admission rows. Same-origin and valid-cookie checks precede admission; malformed bodies with a valid visitor session still consume burst capacity. A later validation, provider or model failure does not restore that request's burst unit. Active-scan leases release when a stream ends or is cancelled and expire after interrupted execution. Expired admission rows receive bounded cleanup. These controls bound application work; creating new anonymous visitor identities remains possible and hosted traffic protection needs an edge or reverse-proxy policy. No report/evidence cache is reused for the next scan.

## Provider scope and failures

Configure BASE_RPC_URL for an approved Base RPC. The local setup's bounded public dRPC defaults use chunks of 10 blocks and a cap of 100 token events; other values remain configurable. Public endpoints can rate-limit, fail or omit data, so sustained service needs suitable provider quotas. Every report declares its finalized block/window, exact amounts and incomplete coverage.

With BLOCKSCOUT_API_KEY, indexed top-level native funding and the fixed authenticated holder route are used. Without that optional operator key, keyless funding scans the **oldest contiguous prefix** of at most 32 full blocks by default; BASE_NATIVE_FUNDING_MAX_BLOCKS accepts 1–256. Only fully verified blocks contribute funding evidence and completed coverage. No completed block means unavailable. A limit or source failure after a prefix means partial with exact bounds. Complete requires the entire declared funding window. Shared call/deadline limits leave unreached candidates individually not examined. Separate balanceOf reads can establish exact balances at the pinned finalized block, but internal native transfers, lifetime-first funding, a complete holder census and live-current balances remain unknown. The public holder endpoint returned HTTP 403 in the narrow live check; observed candidates remain eligible for pinned balance reads.

The supported sale adapter authenticates Base Uniswap v3 pools and a documented router/direct-pool path, then reconciles successful receipts, one swap and exact direct ERC-20 consideration flows. Unsupported routers/protocols, multihop/mixed swaps, smart-wallet routes and native-ETH unwrapping remain unclassified. A transfer alone is not a sale. A live positive native-transfer helper proof exists; a live positive supported-sale benchmark remains outstanding. See [provider verification](provider-verification.md).

Missing models, outages, rejected citations, malformed output, cancellation or deadlines produce an error; there is no canned, synthetic or saved-result fallback. The model explains bounded evidence and cannot change the deterministic findings.

## Checks and read-only verification

```powershell
npm.cmd run check
npm.cmd run test:db
npm.cmd run db:check
npm.cmd run build
npm.cmd run test:e2e

# Separately invoked live provider check:
npm.cmd run verify:base

# With local Next.js and the required model running:
npm.cmd run verify:local
# Optional current-page follow-up verification:
npm.cmd run verify:local -- --ask
```

test:db requires TEST_DATABASE_URL selecting a local disposable traceforge_test_* database. It resets test-only tables and checks quota behavior and absence of new report/evidence/job writes. Migrations must already be applied. Browser fixtures are explicitly synthetic and test UI behavior, not upstream detection accuracy.

verify:local first obtains the same visitor cookie as a browser through a page navigation and keeps it only in memory. It then makes a genuine fresh request, validates mandatory explanation/citations and compares server report/evidence/job counts before/after. It writes verification metadata only, not the report, evidence, signed context, visitor cookie or transcript. Both the main report and every accepted optional question require a real model call. Run it deliberately rather than during every development restart. The real admission browser tests use malformed bodies to exercise visitor isolation and the combined burst limit without provider acquisition or model inference.

An earlier local run passed at **2026-10-12 04:36:29.446 UTC**: a 74.751-second fresh scan, profile 1.3.0, 78 evidence records, partial coverage, and 55 funding histories not examined. Its signed question returned one citation in 26 ms, and legacy job/evidence/investigation counts were unchanged. That historical run predates mandatory inference for every accepted question, the current visitor-admission policy and later report changes. See [reliability](reliability.md) for current verification scope; hosted performance remains unverified.

verify:base and the separate positive-case verifier are operator-only read-only checks that can save public chain artifacts under ignored .artifacts. They are not invoked by a visitor scan. A second endpoint comparison does not establish independent infrastructure, complete coverage or detection accuracy.

See [deployment](deployment.md), [database](database.md), [architecture](architecture.md), [AI evaluation](ai-evaluation.md) and [reliability](reliability.md) for remaining verification limits.
