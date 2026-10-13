# TraceForce Engine

TraceForce Engine investigates a Base token through fresh, bounded blockchain reads and presents an interactive report with a required evidence-grounded AI explanation. It is free to use without sign-in, wallet connection, payment, or token ownership.

The primary goal is to reconstruct the token's story: who funded examined wallets, which wallets are connected, who accumulated early, and what transaction evidence suggests coordinated selling. Each conclusion must retain its evidence and acquisition limits. The deployment target is Next.js on Vercel, MySQL on Hostinger, and a protected scan/AI engine as needed; hosted operation is not yet configured or verified.

The public flow streams progress and a report directly to the visitor. It does not save token parameters, reports, evidence, or chat history in a server database or on disk. MySQL stores anonymous short-window counters and expiring active-scan leases only. Visitors can explicitly save a report snapshot in their own browser, download it, delete snapshots, or clear them. A new scan always crawls again.

## What is implemented

- Full-scope Base transfer acquisition from genesis by default, optional Alchemy paginated token/native-funding discovery, receipt/block checks, configured RPC alternatives, and exact completed-range coverage.
- A recipient-filtered SQD funding adapter for explicit local evaluation, with canonical anchors and RPC-verified positive transactions; hosted production needs approved access.
- Deterministic wallet links, evidence-linked groups, earliest-observed accumulation, and narrowly supported selling findings.
- Investigative leads identify relevant wallets, retained transaction proofs and concrete next checks. Upstream funders and later proceeds are follow-up targets; this list does not execute those additional searches.
- GoPlus reported holder counts, Top10 candidates and selected contract checks; optional Blockscout PRO discovery; exact RPC balances at the pinned finalized block, with unread candidates disclosed.
- An interactive wallet dashboard with proportional pinned-supply circles, wallet/evidence views, activity replay, cited findings, and mandatory AI review. Local Ollama is preferred, with optional configured Gemini fallback.
- The report opens with its plain-English summary, graph, holders and verdict. The four investigation cards sit below the main report. The finalized block/time and exact share denominator are visible; supporting observations, leads and model details expand on request.
- Compact reference-style holder table: Wallet, Float, Entry, Txs, Flags and Swarm. Authenticated V2/v3 pools are excluded from ordinary wallet links; supported purchases, initial V2 liquidity, pinned account state and exact balances supply the visible entry/flag data.
- Top holders appears beneath the graph in the main desktop column, beside the verdict panels; clusters follow below the replay. Full-crawl holding replay focuses on acquired token activity instead of compressing it against Base genesis.
- Verdict/category panels with inspectable warning gates, real measurements and honest score bounds. Unknown components do not earn favorable points or invented probabilities. Source-reported creator/contract context stays attributed.
- Compact Verdict Output calculates normalized local rule weights and exposes their raw contributions in Decision X-ray. Score rows show earned points, using 0 for unassessed credits while retaining unknown measurements in Details. Receipts identify the model and actual arithmetic; weights are not calibrated probabilities.
- Source-reported token websites and selected-pair market metrics from one bounded DEX Screener lookup. Pool quotes retain exact reported precision and show their source/time; negligible, low or unknown liquidity is disclosed beside the quote. Wallet rows, contract holdings and source-reported totals have distinct labels.
- Follow-up chat through a signed, 30-minute scan context and bounded recent conversation. Every accepted turn, including greetings, invokes the configured AI provider; no server conversation history.
- Optional IndexedDB snapshots, bounded to five reports and 20 MiB of serialized report data per browser/origin.
- Visitor-created SVG report cards and token links that prefill a new scan without publishing or storing the original report.
- Per-visitor protection: 30 scan/question requests per 30 seconds and one active scan per browser visitor, including localhost. No hourly quota; separate browsers have separate signed anonymous identities.

A complete holder census, live-current balances, a complete token audit, internal native traces, broad DEX coverage, ownership attribution, and detection-accuracy guarantees are not implemented. GoPlus's reported count is separate from its documented Top10 list and from RPC-verified candidates; ten returned addresses are not an application wallet cap. The main holder table shows verified EOA rows. Its Float subtracts authenticated pools, retained burns and known contract balances at the pinned block. Default Wallets bubbles use these same rows, denominator and rounded percentages. Contracts remain visible separately and in All addresses, and stay included in risk analysis; unverified account types are shown separately. Incomplete classification or balance reads fall back to explicitly labeled total-supply percentages. Neither representation identifies human owners. Market values, website links and contract checks remain external source reports. Home/scan laser illustrations are decorative; report graphs use acquired evidence. Missing observations remain unknown.

The report customizes installed Aceternity Bento components into a graphite/lime diagnostic interface with generated TraceForce logo/icons. Positive holding-circle area is proportional to verified balance / the selected view's disclosed denominator; unknown, zero and known infrastructure markers do not pretend to have a holding share. Colors follow the browser/system light or dark preference automatically, with no theme switch or stored theme. Decorative effects respect reduced motion and can be paused. The scroll-following Tracing Beam treatment was removed. The installed Aceternity collision-beam component supplies decorative home/scan lasers covered by the browser checks below. See [the component and brand record](docs/ui-components.md).

## Run locally

Use Node.js 22–24 and the committed npm lockfile. Start MySQL in XAMPP; Apache is unnecessary.

    npm ci
    npm run db:setup:local
    npm run db:migrate
    npm run db:migrate:test

The setup writes generated local credentials to ignored .env.local without printing them. Existing traceforge_* database names remain for compatibility. Migrations are explicit and never run during startup or build.

Configure an approved BASE_RPC_URL and investigator AI using [the AI guide](docs/local-ai.md). The preferred local model is traceforce-investigator over qwen3:4b-instruct-2507-q4_K_M, profile 1.4.0. An optional server-only GEMINI_API_KEY in .env.local enables availability fallback, or direct Gemini inference when LOCAL_AI_MODEL is absent. The blank placeholder is not a configured key. Restart after changing configuration, then start the app:

    npm run dev

Open http://localhost:3000/investigate. Local Next.js performs acquisition and inference directly. No job worker or polling command is needed; the old worker CLI is retired. Browser closure/disconnection cancels active work rather than leaving a resumable server job.

Full history is the default scan scope; recent 100–20,000-block windows remain an explicit option. RPC log chunks default to 1,000,000 blocks and split only on explicit range/result-size limits. An older local override uses 1,000-block chunks. Optional Alchemy token/funding readers use cursor pagination instead of walking empty block ranges; every retained candidate still requires canonical RPC verification. One bounded DEX metadata read overlaps chain acquisition. Provider restrictions can leave any requested history partial.

On Vercel, a protected HTTPS scan engine is required. The prepared [Linux runbook](deploy/linux/README.md) places that engine beside private Ollama on the planned Hostinger KVM 2. Optional Gemini credentials belong only on the protected engine. No hosted deployment or CPU-host performance is claimed.

## Verify changes

    npm run check
    npm run db:check
    npm run test:db
    npm run build
    npm run test:e2e

The genuine database suite requires an explicitly migrated, disposable local traceforge_test_* database. Eighteen tests passed on local MariaDB 10.4.32, including concurrent per-visitor admission, scan leases, expiry/cleanup, absence of saved jobs/evidence/reports and legacy compatibility. Migration 0003 was explicitly applied to the local application and disposable test databases. Fixture tests do not establish live model quality or provider accuracy. See [reliability](docs/reliability.md) and [dated provider verification](docs/provider-verification.md).

The compact report and creator-source funding revision passed lint, TypeScript, **696 unit tests**, the production build and **89/89 Playwright scenarios**. Tests cover exact category arithmetic, incomplete-balance qualification, complete wallet-set comparison, canonical creator funding, graph/table parity, evidence navigation, responsive layout, CSP and real visitor admission. Synthetic desktop/mobile screenshots were inspected beside the public reference. See [reliability](docs/reliability.md) for the dated checks and limits.

The latest complete public workflow passed at **2026-10-12 15:17:40.090 UTC** for ANTHROPIC, from genesis through finalized **52,513,705**. Genuine local AI completed the report in **128.144 seconds**. The six measured categories earned **44.8 → 45 / AVOID**; every one of the **12 wallet shares** matched the cached reference at display precision. An independent public RPC matched **16/16 candidate balances**, total supply, account state and pool reserves at that exact block. Live Playwright checks verified all default bubbles against the table, score/receipt consistency, evidence highlighting and desktop/mobile layout. Database counts stayed **2/0/0**. The direct-creator source query completed; ordinary recipient funding and holder discovery remained incomplete. No raw report, evidence or chat archive was saved. These results verify retained state and presentation, not an exhaustive census or superior prediction accuracy. [Exact live result and limitations](docs/provider-verification.md#compact-score-reference-parity-and-independent-state--2026-10-12-1517-utc)

The main report requires genuine inference from the configured provider to review and order findings and select their relevant caveats. Local Ollama is preferred; optional Gemini fallback runs only when local inference is unavailable or times out. Invalid output or grounding failures remain errors. Profile **1.4.0** restores published facts from the exact canonical findings and complete evidence proof; generated factual paraphrases are rejected. This corrects the earlier **1.3.0** synthetic shared-infrastructure wording failure. Chat still generates natural replies through actual inference on every accepted turn. Source completeness, analyzer correctness, selection quality and generative chat semantics require their own validation; canonical matching is not a general accuracy guarantee.

At 2026-10-12 06:30:30.517 UTC, the actual SQD funding adapter verified a known historical native-funding transaction against dRPC transaction, receipt, code and canonical block reads. The bounded check took 4.535 seconds and nine HTTP requests. It validates one positive transaction in one indexed block, not complete funding history, indexer omissions, current scan coverage or hosted production access. See [the provider verification record](docs/provider-verification.md).

Before the GoPlus and interface updates, the real HTTP workflow passed at 06:39:22.123 UTC: a 104.819-second scan returned 82 receipt-backed transfers, completed indexed funding searches for 61 wallets in the declared 100-block window, and verified all 70 retained candidate balances at the pinned block. Six contract recipients remained outside the funding adapter's scope; no qualifying native-funding event was retained in that window. The actual Ollama follow-up returned in 47.937 seconds, and database job/evidence/report counts stayed unchanged at 2/0/0. Transfer coverage and holder discovery remained incomplete. This historical run verifies those recovery fixes, not the latest source, complete history, a holder census, sustained availability, or general AI accuracy.

## Documentation

- [Architecture](docs/architecture.md)
- [Security and privacy boundaries](docs/security.md)
- [Database and migrations](docs/database.md)
- [Local and hosted deployment](docs/deployment.md)
- [Reliability and supported claims](docs/reliability.md)
- [Data sources](docs/data-sources.md)
- [Local development](docs/local-development.md)
- [AI setup and verification](docs/local-ai.md)
- [Interface components and brand assets](docs/ui-components.md)
- [SWARM public reference review](docs/swarm-reference-review.md)

Product name: **TraceForce Engine**. No token contract, ticker, tokenomics, or production domain is assumed.
