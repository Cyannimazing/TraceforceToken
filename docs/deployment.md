# TraceForce Engine local and hosted deployment

Reviewed: **2026-10-12**. The new public architecture uses request-only fresh scans and optional visitor-browser snapshots. No hosted resource, domain, remote database connection, Linux service, or Hostinger performance result is claimed here.

## Local development

Use a patched Node.js 22 or 24 LTS release and the committed lockfile. Node.js 23 is end-of-life despite fitting the package range. [Node release status](https://nodejs.org/en/about/previous-releases). Start XAMPP MySQL, then:

    npm ci
    npm run db:setup:local
    npm run db:migrate
    npm run db:migrate:test

Generated local secrets stay in ignored .env.local. The existing application/test databases received migrations 0000–0003 on MariaDB 10.4.32. Public execution uses only anonymous visitor counters and expiring scan leases; legacy schema remains for compatibility.

Configure an approved Base RPC and the required specialist through [local AI setup](local-ai.md). Start private Ollama and the reviewed named traceforce-investigator model, then:

    npm run dev

Open http://localhost:3000/investigate. Without SCAN_ENGINE_URL, non-Vercel Next.js runs acquisition/inference directly. A submitted request streams progress and a report; there is no enqueue/poll step. Old worker commands are retired.

Each anonymous browser visitor has a combined 30 scan/question requests per 30-second window and one active scan, including localhost. Page navigation initializes the signed visitor cookie; APIs require it. Tabs share an identity, while separate browsers have independent allowances. There is no hourly quota. Browser Save stores a bounded snapshot only on that browser/origin. Reload loses an unsaved report and current chat; restored snapshots need a fresh scan for questions.

## Prepared hosting split

| Service | Runs | Receives |
| --- | --- | --- |
| Vercel | Next.js pages, validation, visitor admission, protected engine proxy | SITE_URL, RATE_LIMIT_SECRET, verified-TLS DATABASE_URL, engine URL/secret |
| Shared MySQL/MariaDB | Anonymous short-window counters and expiring scan leases | Restricted admission/runtime access; separate migration account |
| Hostinger KVM 2 | One stateless Node engine beside private Ollama | Provider/model settings and SCAN_ENGINE_SECRET; no DB credentials |
| Visitor browser | Current report/chat; explicit optional IndexedDB snapshots | Validated result and short-lived signed context; no infrastructure secret |

An optional [one-VPS cohosting profile](../deploy/linux/cohost/README.md) places quota-only MySQL Community 8.4 LTS on the same KVM 2 as the engine and Ollama. Next.js stays on Vercel; the engine still receives no DB credentials. Its separate drop-ins budget 4608 MiB for Ollama, 768 MiB for the engine and 768 MiB for MySQL (6 GiB combined), with lower aggregate CPU ceilings and explicit OS/proxy headroom. This is prepared configuration, not a measured fit or deployed system. Direct Vercel-to-MySQL access remains gated on certificate/hostname-verified TLS, narrow runtime grants and reviewed fixed-egress firewall rules; Vercel Static IPs are paid Pro/Enterprise functionality. No additional database hosting plan is inherently required, but connectivity costs are separate. [Vercel Static IPs](https://vercel.com/docs/networking/static-ips)

When VERCEL=1, local fallback is prohibited. Set SCAN_ENGINE_URL to a trusted HTTPS origin with exact /scan path and a separate private 32–512-character SCAN_ENGINE_SECRET. Next.js uses /ask on that origin for questions. Do not use NEXT_PUBLIC_* for any secret.

The engine listens on 127.0.0.1:8787; Ollama on 127.0.0.1:11434. An operator-managed HTTPS proxy exposes exact bearer-protected POST /scan and /ask, with buffering/cache/body logging disabled. Keep both loopback ports off the public network. Next.js verifies destination DNS and rejects redirects; actual TLS, DNS, firewall and egress behavior still require deployment review.

The [Linux runbook and units](../deploy/linux/README.md) provide concrete preparation commands. Historical filenames traceforce-worker.service and worker.env.example now run the stateless engine. They do not run a durable worker, install a model, apply migrations, or require database credentials. The tsx loader needs installed development dependencies; no Next.js build is needed on the VPS.

An optional `BASE_LOG_RPC_URL` belongs in the engine environment only. It selects one approved HTTPS log endpoint independently of the state RPC/fallback order; the same DNS, deadline, body and counted identity checks apply. Omit it to retain a single RPC lane. Configuration preflight rejects it on Vercel or under a public-prefixed name. Reachability does not establish log access: PublicNode refused older ranges despite successful chain/header checks. The latest local combination kept PublicNode for logs and official Base as dRPC's state fallback, retaining 34 verified transfers while preserving partial coverage after a second refused range. Review [provider verification](provider-verification.md#independent-log-lane-and-known-positive-transfer) before choosing access plans; this is not a deployed capacity or complete-access guarantee.

## Executable configuration review

[deploy/vercel.env.example](../deploy/vercel.env.example) is the server-only Vercel environment inventory; [worker.env.example](../deploy/linux/worker.env.example) is the separate engine inventory. Keep filled copies outside the release/source tree in a private secret store. Do not upload local `.env.local`: it includes local database, migration/test, retired cron and provider/model settings that do not belong in Vercel. Secrets must be entered for the intended project/environment rather than bundled into client assets.

The [offline preflight](../deploy/preflight.ts) reuses the application's configuration readers and adds checks for the prepared hosting split. Load only the intended private environment explicitly; it never reads local env files on its own:

```bash
node --env-file=/secure/operator/vercel.env --import tsx deploy/preflight.ts --target vercel
node --env-file=/secure/operator/engine.env --import tsx deploy/preflight.ts --target engine
node --import tsx --test deploy/preflight.test.ts
```

It prints static pass/fail descriptions, performs no network/inference/database actions and exits 1 for invalid configuration. Vercel checks simulate production/Vercel flags, require a public HTTPS origin/engine, verified remote DB TLS, separated credentials and an explicit one- or two-connection pool for the cohost budget. Engine checks reject DB/quota credentials, remote inference and resource settings outside the prepared CPU profile. Configuration readiness is separate from actual account/project access, schema/grants, TLS, networking, effective systemd settings and host capacity; those remain explicitly unverified in the output.

The **2026-10-12 workstation audit** found Node/npm/SSH/SCP available, no Vercel CLI or local project link, and no SSH host aliases. Local engine/provider/AI/quota settings are present, but a remote engine URL/secret is absent. Running the preflight against the local environment correctly rejected hosted configuration without printing values. These observations do not prove whether external accounts/resources exist; no authenticated cloud target was supplied or accessed.

For direct Vercel-to-VPS MySQL, the fixed-egress gate has a material cost: the current Static IPs documentation lists **$100/month per project on Pro plus regional Private Data Transfer**. It is not included merely by choosing Pro. An alternative HTTPS quota boundary would need separate implementation/review; opening MySQL to all IPs or weakening TLS is not a substitute. [Current Static IP documentation](https://vercel.com/docs/networking/static-ips)

## Capacity, time, and resources

One process permits up to three active operations, overlapping acquisition, and one inference. Questions share this capacity. At most two admitted operations wait for the AI slot; there is no persistent queue or retry/resume. Additional requests can receive 429. More processes would multiply this limit unless explicitly coordinated.

| Boundary | Configured budget |
| --- | --- |
| Scan engine | 270 seconds, including AI waiting |
| Provider collection / local AI | 120 seconds each |
| Next.js remote scan proxy | 285 seconds; route maxDuration 300 |
| Questions | Engine/local 135 seconds; remote proxy 140; route maxDuration 150 |
| Payload | 2 KiB scan request; 48 KiB question request; 8 MiB report; 16 MiB stream |

Configured duration is not proof that a hosting plan/reverse proxy permits that lifetime. Verify real streaming termination, disconnect propagation, buffering, and platform limits. [Vercel duration configuration](https://vercel.com/docs/functions/configuring-functions/duration)

The planned two-vCPU/8-GB KVM host uses qwen3:4b-instruct-2507-q4_K_M through profile 1.4.0, two threads, zero GPU layers, and a 4,096-token context. Ollama is cloud-off, parallel=1, loaded-models=1. The engine-only profile has memory ceilings of 5500 MiB for Ollama and 768 MiB for the engine, with a 384-MiB JS heap. Its combined ceilings are approximately 6.57 decimal GB; MySQL is excluded from that profile. CPU quotas of 175%/25% are ceilings, not reserved cores. The separate cohosting profile above replaces those limits when adding MySQL; neither profile budgets a Next.js build or additional model. Actual MemTotal/process peaks must be measured. [Ollama runtime settings](https://docs.ollama.com/faq)

No CPU latency or sustained throughput is promised. Cold/warm inference, waiting, model memory, SIGTERM/disconnect, throttling and out-of-memory behavior need tests on the actual VPS before changing deadlines.

## Release verification

Run lint/types/unit tests, migration checks, gated disposable-DB tests, a production build, and relevant Playwright checks. Synthetic report/chat tests are not live inference. Historical durable-workflow results do not verify this new stream/question path.

Before hosted use, verify admission database TLS/grants/connection totals, HTTPS/certificates, protected engine authorization, CSP/origin handling, signed visitor cookies, combined burst limits and scan leases, stream bounds, logging hygiene, CPU/memory/deadlines and load. Anonymous identities can be recreated; hosted DDoS protection also needs a reviewed edge or reverse-proxy policy. Set the actual SITE_URL; indexing needs explicit ALLOW_INDEXING=true under production conditions. Investigation/API routes remain noindex/no-store. No production domain is assumed.
