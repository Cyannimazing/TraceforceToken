# TraceForge Engine

TraceForge Engine investigates a Base token through fresh, bounded blockchain reads and presents an interactive report with a required evidence-grounded AI explanation. It is free to use without sign-in, wallet connection, payment, or token ownership. Base mainnet (8453) is the only enabled network; external services' other chains are not supported by implication.

The primary goal is to reconstruct the token's story: who funded examined wallets, which wallets are connected, who accumulated early, and what transaction evidence suggests coordinated selling. Each conclusion must retain its evidence and acquisition limits. The deployment target is Next.js on Vercel, MySQL on Hostinger, and a protected scan/AI engine as needed; hosted operation is not yet configured or verified.

The public flow streams progress and a report directly to the visitor. It does not save token parameters, reports, evidence, or chat history in a server database or on disk. MySQL stores anonymous short-window counters and expiring active-scan leases only. Visitors can explicitly save a report snapshot in their own browser, download it, delete snapshots, or clear them. A new scan always crawls again.

## What is implemented

- Full-scope Base transfer acquisition from genesis by default, optional Alchemy paginated token/native-funding discovery, receipt/block checks, configured RPC alternatives, and exact completed-range coverage.
- A recipient-filtered SQD funding adapter for explicit local evaluation, with canonical anchors and RPC-verified positive transactions; hosted production needs approved access.
- Deterministic wallet links, evidence-linked groups, earliest-observed accumulation, and narrowly supported selling findings.
- Investigative leads identify relevant wallets, retained transaction proofs and concrete next checks. Upstream funders and later proceeds are follow-up targets; this list does not execute those additional searches.
- GoPlus reported holder counts, Top10 candidates and selected contract checks; optional Blockscout PRO discovery; exact RPC balances at the pinned finalized block, with unread candidates disclosed.
- An interactive wallet dashboard with SWARM-reported grouped bubbles and holder rows, independent blockchain/evidence views, activity replay, cited findings, and mandatory AI review. OpenRouter defaults to the free router with zero-price filters and no paid cloud fallback; local Ollama remains available.
- New SWARM-led reports open with a short plain-English action and source-reported score, verdict, market context, grouped graph and holders from the same fresh-request snapshot. Independent Alchemy/RPC checks remain separately attributed. Missing SWARM data stays unavailable; a local score does not silently replace it. Supporting story cards, evidence and replay expand under Investigation details. No raw JSON, model receipt or debug panel appears in normal report/chat flows.
- Compact reference-style main holder table: Wallet, Float, Entry, Txs, Flags and Swarm, retaining SWARM's reported cohort and values. The separately labeled independent graph/table uses pinned balances and account state, with contracts and unread candidates identifiable.
- Top holders appears beneath the graph in the main desktop column, beside the verdict panels; clusters follow below the replay. Full-crawl holding replay focuses on acquired token activity instead of compressing it against Base genesis.
- Main verdict/category panels preserve SWARM's reported score, category points and decision weights without recomputing or mixing local populations. These weights are source model outputs, not independently calibrated probabilities. Missing source values remain unavailable.
- Independent local assessment preserves exact category arithmetic, warning precedence and missing-check disclosure. A fully assessed clean set can say OK; missing information cannot become a favorable zero or a clean result. Historical snapshots without an explicit source-authority flag retain their original local presentation.
- A fresh SWARM scan provides the main reported assessment and bounded address leads; Alchemy/RPC independently acquires and verifies supported blockchain observations. Optional authenticated Bubblemaps/Nansen adapters supply additional candidates, with explicit availability states. Provider scores, labels and relationships cannot overwrite independently verified facts. Optional-source failure does not block the independent findings.
- A separate selected-pool exit quote uses pinned authenticated Uniswap V2 reserves with swap fees, or a bounded V3 QuoterV2 call. It is a quote rather than a successful-sale simulation: token restrictions, taxes, approvals, execution gas, alternate routes and full V3 input consumption remain unverified.
- Main market figures retain the same SWARM assessment's source time. One bounded DEX Screener lookup supplies separately attributed selected-pair context and token websites. Negligible, low or unknown liquidity is disclosed beside quotes; source holder totals, examined wallets, inferred groups and independently checked candidates stay distinct.
- Follow-up chat through a signed, 30-minute scan context and bounded recent conversation. Every accepted turn, including greetings, invokes the configured AI provider; no server conversation history.
- Optional IndexedDB snapshots, bounded to five reports and 20 MiB of serialized report data per browser/origin.
- Visitor-created SVG report cards and token links that prefill a new scan without publishing or storing the original report.
- Per-visitor protection: 30 scan/question requests per 30 seconds and one active scan per browser visitor, including localhost. No hourly quota; separate browsers have separate signed anonymous identities.

A complete holder census, live-current balances, a complete token audit, internal native traces, broad DEX coverage, ownership attribution, and detection-accuracy guarantees are not implemented. SWARM's reported total, examined holder cohort and inferred groups are separate populations; its “hands” are not verified people or owners. The main graph and holder table keep that source's shares and group membership. The independent pinned EOA table and its graph share their own denominator: authenticated pools, retained burns and known contracts are excluded from wallet Float, while contracts remain in separate risk checks. Incomplete classification or balances use an explicitly labeled total-supply basis. GoPlus's reported count and documented Top10 list are separate from RPC-verified candidates; ten returned addresses are not an application wallet cap. Source agreement does not independently verify a provider's private formula. Missing observations remain unknown.

The TraceForge interface uses self-hosted serif/sans typography, an original vector tracing mark and a persistent animated pixel/network background across routes. An articulated six-legged crawler explores collision-checked safe areas without capturing pointer input. Light/dark mode follows the system until the visitor chooses a saved preference. Effects can be paused and the crawler hidden; reduced motion and hidden tabs stop ambient work. Holding-circle area uses the selected view's disclosed share basis: source-reported shares in the main SWARM graph and pinned balances in the independent graph. Unknown, zero and infrastructure markers do not pretend to have a holding share. See [the component and brand record](docs/ui-components.md).

## Run locally

Use Node.js 22–24 and the committed npm lockfile. Start MySQL in XAMPP; Apache is unnecessary.

    npm ci
    npm run db:setup:local
    npm run db:migrate
    npm run db:migrate:test

The setup writes generated local credentials to ignored .env.local without printing them. Existing traceforge_* database names remain for compatibility. Migrations are explicit and never run during startup or build.

Configure an approved BASE_RPC_URL and investigator AI using [the AI guide](docs/local-ai.md). For free OpenRouter, set `INVESTIGATOR_AI_PROVIDER=openrouter`, your private `OPENROUTER_API_KEY`, `OPENROUTER_MODEL=openrouter/free` and `OPENROUTER_FREE_ONLY=true` in ignored `.env.local`, then restart. No Gemini key is needed. Missing free service returns an error; it does not switch to a paid model. Automatic mode can try local inference first but excludes Gemini when free-only OpenRouter is configured. The local option remains traceforce-investigator over qwen3:4b-instruct-2507-q4_K_M, profile 1.6.0; run `npm.cmd run ai:setup` after a profile change. This specializes instructions, not model weights. Start the app:

    npm run dev

Open http://localhost:3000/investigate. Local Next.js performs acquisition and inference directly. No job worker or polling command is needed; the old worker CLI is retired. Browser closure/disconnection cancels active work rather than leaving a resumable server job.

`OPENROUTER_ALLOW_DATA_COLLECTION` defaults to `false`. Operator-approved `true` permits free providers that may retain or train on supplied prompts/responses; it does not change free-only prices or evidence checks. Some endpoints also require a separate OpenRouter account privacy preference. See [data-use setup and verification limits](docs/local-ai.md#provider-selection-and-openrouter-setup).

Full history is the default scan scope; recent 100–20,000-block windows remain an explicit option. RPC log chunks default to 1,000,000 blocks and split only on explicit range/result-size limits. An older local override uses 1,000-block chunks. Optional Alchemy token/funding readers use cursor pagination instead of walking empty block ranges; every retained candidate still requires canonical RPC verification. One bounded DEX metadata read overlaps chain acquisition. Provider restrictions can leave any requested history partial.

On Vercel, a protected HTTPS scan engine is required. The prepared [Linux runbook](deploy/linux/README.md) places that engine beside private Ollama on the planned Hostinger KVM 2; its existing Ollama service dependencies are unchanged. OpenRouter/Gemini credentials belong only on the protected engine, never the Vercel web tier or public variables. A genuine pinned NVIDIA free-model trial passed one synthetic report, greeting and cited funding answer with zero recorded API cost; [exact scope and limits](docs/local-ai.md#provider-selection-and-openrouter-setup). This is not live-chain accuracy or hosted deployment verification.

Optional `BUBBLEMAPS_API_KEY` and `NANSEN_API_KEY` belong only in the local/protected engine environment, never `NEXT_PUBLIC_` or the Vercel web tier. `ENRICHMENT_TIMEOUT_MS` defaults to 12,000. Confirm API/account redistribution rights before activation; a valid key alone is not permission. Arkham remains rights-required, RugCheck is unsupported for Base here, and Honeypot.is has no runtime integration because its published terms restrict third-party/competing use. Missing optional keys are disclosed as not configured, without blocking local evidence acquisition. Upstream services may retain their own requests/results even though TraceForge stores no server report history. [Hybrid authority](docs/architecture.md#hybrid-sources-and-authority), [access and privacy](docs/security.md#optional-source-access-and-privacy).

The SWARM integration currently uses fresh scan/events/result only. Council, cached token/history, replay, DNA, wallet X-ray, radar, cabals, feeds and share-card APIs are not implemented. TraceForge's local Deployer DNA panel concerns this scan's retained creator evidence, not complete cross-token creator history.

## Verify changes

    npm run check
    npm run db:check
    npm run test:db
    npm run build
    npm run test:e2e

The genuine database suite requires an explicitly migrated, disposable local traceforge_test_* database. Eighteen tests passed on local MariaDB 10.4.32, including concurrent per-visitor admission, scan leases, expiry/cleanup, absence of saved jobs/evidence/reports and legacy compatibility. Migration 0003 was explicitly applied to the local application and disposable test databases. Fixture tests do not establish live model quality or provider accuracy. See [reliability](docs/reliability.md) and [dated provider verification](docs/provider-verification.md).

The earlier compact report and creator-source funding revision passed lint, TypeScript, **696 unit tests**, the production build and **89/89 Playwright scenarios**. Tests covered exact category arithmetic, incomplete-balance qualification, complete wallet-set comparison, canonical creator funding, graph/table parity, evidence navigation, responsive layout, CSP and real visitor admission. Synthetic desktop/mobile screenshots were inspected beside the public reference. Those counts describe that revision, not an automatic pass for the current hybrid/human-summary changes. See [reliability](docs/reliability.md) for dated checks and limits.

The recorded complete public workflow passed at **2026-10-12 15:17:40.090 UTC** for ANTHROPIC, from genesis through finalized **52,513,705**. Genuine local AI completed the report in **128.144 seconds**. The six measured categories earned **44.8 → 45 / AVOID**; every one of the **12 wallet shares** matched the cached reference at display precision. An independent public RPC matched **16/16 candidate balances**, total supply, account state and pool reserves at that exact block. Live Playwright checks verified all default bubbles against the table, score/receipt consistency, evidence highlighting and desktop/mobile layout. Database counts stayed **2/0/0**. The direct-creator source query completed; ordinary recipient funding and holder discovery remained incomplete. No raw report, evidence or chat archive was saved. These results verify that revision's retained state and presentation, not the current changes, an exhaustive census or superior prediction accuracy. [Exact live result and limitations](docs/provider-verification.md#compact-score-reference-parity-and-independent-state--2026-10-12-1517-utc)

The main report requires genuine inference from the configured provider to review and order findings and select their relevant caveats and short decision reasons. Provider selection and availability fallback share one bounded deadline; invalid output or grounding failures remain errors. Profile **1.6.0** writes a short AI explanation grounded in selected structured decision reasons, while source authority, action, verdict, canonical findings and complete evidence references retain their validation. Source-reported reasons remain distinct from chain citations. Legacy **1.5.0** retains canonical text selection. Missing or invalid generated text remains an error, with no preset successful fallback. The earlier **1.4.0** selector protocol corrected the **1.3.0** synthetic shared-infrastructure wording failure and remains supported for saved snapshots. Chat generates natural replies through actual inference on every accepted turn, including ordinary buy/risk questions and follow-ups; ordinary assessment questions use the same primary SWARM snapshot, while explicit independent-check questions use their own source lane. Source completeness, analyzer correctness, selection quality and generative chat semantics require their own validation; canonical matching is not a general accuracy guarantee.

For a deliberate local full-workflow check against a running app, configure the approved provider and AI environment first, then run:

    node --conditions=react-server --import tsx scripts/verify-local-workflow.ts --origin=http://localhost:3000 --token=0xf8cc1cf8c4fe4697460a7fdcab521a1e7cc438df --full --browser --independent-state --reference

This creates a fresh scan, verifies retained pinned state against an independent RPC and checks rendering/interaction with Playwright. The reference comparison is separate and may legitimately disagree because source time, holder population or policy differs; it is not a requirement to copy another verdict. The script writes verification metadata only, not a raw report, evidence, capsule or chat archive. Genuine model semantic review and a real-account Gemini/provider trial remain separate from fixture passes; record their exact date, source scope, failures and limits before claiming them. Database tests above require the disposable migrated test database and must not target an application database.

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

Product name: **TraceForge Engine** (formerly TraceForce). Internal model/profile/cookie identifiers retain their legacy spelling for compatibility. No token contract, ticker, tokenomics, or production domain is assumed.
