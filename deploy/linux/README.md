# Hostinger KVM 2 stateless engine preparation

These templates are **not an installed or verified cloud deployment**. Target: x86-64 Linux, systemd/cgroup v2, two vCPUs and 8 GB RAM. Verify the actual OS, CPU support, memory, disk, systemd and binary paths on the purchased host.

Vercel serves Next.js and proxies scans to one private VPS engine beside CPU-only Ollama. Every scan acquires fresh Base evidence, analyzes it and streams a mandatory explanation to its browser. The runtime saves no reports, evidence or history to a database or disk. There is no durable queue, polling, retry job or resumable result. Disconnect/restart loses active work. Operator verification artifacts are separate from the deployed request path.

The historical filenames traceforce-worker.service and worker.env.example now configure [scripts/scan-engine.ts](../../scripts/scan-engine.ts). No database credentials belong here. The browser never receives its secret or reaches Ollama. Ports 8787 and 11434 must stay private. No provisioning, firewall changes, downloads or installation have been performed.

## Capacity and resource limits

One process admits **three active operations**, overlapping fresh acquisition, and grants **one AI slot**. At most the other two admitted operations wait in memory; excess requests receive 429. A scan's **270-second deadline includes AI waiting**. Acquisition/inference each have 120-second limits. Questions share that capacity with a 135-second overall deadline. Waiting can exhaust a deadline; three active operations is not a throughput promise.

| Process | Prepared limit |
| --- | --- |
| Ollama | One model/inference, two threads, 4,096-token context, CPUQuota=175% |
| Ollama memory | MemoryHigh=5G, MemoryMax=5500M; no service swap |
| Engine | CPUQuota=25%, 384 MiB JS heap, MemoryHigh=512M, MemoryMax=768M |

Combined hard memory ceilings are about **6.57 GB**, leaving about **1.43 GB** of marketed 8 GB before kernel/other processes. Check actual MemTotal; GB differs from GiB. No MySQL, Next.js build, second engine or extra model is budgeted. About 2.5 GB model files do not establish RSS/context overhead. Limits can throttle or kill processes; desktop measurements do not prove Hostinger fit/latency. CPU quotas are ceilings, not reserved cores. [systemd controls](https://github.com/systemd/systemd/blob/main/man/systemd.resource-control.xml)

For MySQL, engine and Ollama on **one** VPS, use the separate [cohosting profile](cohost/README.md), which reduces Ollama's ceiling and budgets all three services. Its explicit TLS/network/grant steps remain unverified operator preparation. Do not add MySQL to this engine-only budget unchanged.

Use **qwen3:4b-instruct-2507-q4_K_M**, named **traceforce-investigator**, committed profile **1.3.0**, at most **12 context evidence records**, **two CPU threads**, and zero GPU layers. Custom instructions are not fine-tuned weights or an accuracy guarantee. [Official model listing](https://ollama.com/library/qwen3:4b-instruct-2507-q4_K_M)

## Prepare a reviewed release

Install a patched Node.js 22 or 24 LTS release and reviewed Ollama; verify binary paths and the Ollama system account. Node.js 23 is end-of-life despite fitting the package's numeric range. The prepared unit follows the current official `/usr/bin/ollama` service path; an installation under `/usr/local/bin` needs a reviewed ExecStart override before starting. [Node release status](https://nodejs.org/en/about/previous-releases), [official Linux installation](https://docs.ollama.com/linux)

```bash
command -v node
command -v npm
command -v ollama
id ollama
```

```bash
sudo useradd --system --user-group --home-dir /var/lib/traceforce --create-home --shell /usr/sbin/nologin traceforce
sudo install -d -o root -g root -m 0755 /opt/traceforce/releases
sudo install -d -o root -g root -m 0700 /etc/traceforce
```

Copy reviewed source to /opt/traceforce/releases/RELEASE_ID, run npm ci as deployer and point /opt/traceforce/current at it. The tsx loader needs development dependencies; no VPS Next.js build is needed. Code must be readable but unwritable by the service account. Exclude .env files, .artifacts, .next, local databases and model downloads. The engine reads only its process environment.

Copy worker.env.example to /etc/traceforce/worker.env, root-owned mode 0600. Fill its deliberately blank secret with a private random ASCII value of 32–512 characters; an unchanged copy must fail startup. Set the identical SCAN_ENGINE_SECRET in Next.js server environment and set SCAN_ENGINE_URL=https://engine.example.invalid/scan after replacing the hostname with a verified HTTPS endpoint. Never use NEXT_PUBLIC_* or log these values. No database/migration secrets belong in either engine service. Optional Blockscout indexing needs its key; keyless native funding instead examines an oldest prefix of at most 32 full blocks, publishing exact partial/unavailable coverage.

Before starting the engine, run the [offline deployment preflight](../preflight.ts) in a short-lived process with only the reviewed engine environment. A root-run transient service loads the root-only EnvironmentFile without placing values in command arguments or granting the engine account access to the file:

```bash
sudo systemd-run --wait --collect --pipe --unit=traceforce-engine-preflight \
  --property=Type=exec --property=User=traceforce \
  --property=WorkingDirectory=/opt/traceforce/current \
  --property=EnvironmentFile=/etc/traceforce/worker.env \
  /usr/bin/node --import tsx deploy/preflight.ts --target engine
```

This performs no network, model inference, SQL or DDL. It prints static pass/fail descriptions and exits nonzero for invalid settings. It does not read `.env.local` automatically or prove model installation, DNS/TLS, service limits or Linux capacity. Use a clean reviewed release and keep migration/quota credentials out of this environment.

## Model and engine services

Review both units. Stop/disable a conflicting installer-created Ollama service. Explicitly install/validate:

```bash
sudo install -o root -g root -m 0644 deploy/linux/traceforce-ollama.service /etc/systemd/system/traceforce-ollama.service
sudo install -o root -g root -m 0644 deploy/linux/traceforce-worker.service /etc/systemd/system/traceforce-worker.service
sudo systemd-analyze verify /etc/systemd/system/traceforce-ollama.service /etc/systemd/system/traceforce-worker.service
sudo systemctl daemon-reload
sudo systemctl start traceforce-ollama.service
curl --fail --max-time 5 http://127.0.0.1:11434/api/version
```

The Ollama unit hides GPU devices, disables cloud features and configures one model/inference slot. Confirm it listens only on 127.0.0.1:11434; engine env settings alone do not configure Ollama. [Runtime settings](https://docs.ollama.com/faq)

Download/setup are deliberate separate actions, never service startup:

```bash
cd /opt/traceforce/current
OLLAMA_HOST=127.0.0.1:11434 ollama pull qwen3:4b-instruct-2507-q4_K_M
LOCAL_AI_BASE_URL=http://127.0.0.1:11434 LOCAL_AI_MODEL=traceforce-investigator npm run ai:setup
OLLAMA_HOST=127.0.0.1:11434 ollama show traceforce-investigator --modelfile
sudo systemctl start traceforce-worker.service
curl --fail --max-time 5 http://127.0.0.1:8787/health
```

Confirm actual profile 1.3.0. GET /health is liveness only. POST exactly /scan requires Authorization: Bearer <secret>, JSON and at most 2,048 body bytes. POST exactly /ask uses the same secret, up to 48 KiB JSON, question at most 1,000 characters and signed context at most 32 KiB. Startup validates provider/AI configuration. No cookies, CORS or forwarded-client-IP interpretation is provided.

The signed question context expires after 30 minutes and remains in browser memory. It is not encrypted or server report storage. Questions explain that bounded snapshot; newer or omitted evidence requires a fresh scan. Reload discards the report/context.

## HTTPS streaming reverse proxy

Expose only exact /scan and /ask through an operator-controlled HTTPS proxy. Keep 8787/11434 blocked publicly. Replace hostname/certificate placeholders and validate the actual TLS chain. Next.js sends authorization; do not hardcode the secret in nginx. Disable body/authorization logging.

```nginx
server {
    listen 443 ssl;
    server_name engine.example.invalid;
    ssl_certificate /etc/letsencrypt/live/engine.example.invalid/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/engine.example.invalid/privkey.pem;
    access_log off;
    client_body_timeout 15s;
    client_body_buffer_size 48k;
    location = /scan {
        limit_except POST { deny all; }
        client_max_body_size 2k;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Host 127.0.0.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
    location = /ask {
        limit_except POST { deny all; }
        client_max_body_size 48k;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Host 127.0.0.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
    location / { return 404; }
}
```

The Vercel scan route requests 300 seconds. Current Fluid compute documentation supports that duration on Hobby and above, but the real project/runtime setting still needs verification. Engine 270 seconds leaves transport overhead, and every intermediary must allow streaming. Vercel's ordinary response payload cap is 4.5 MB; its official guidance exempts streaming responses. Preserve NDJSON streaming and exercise a large bounded response on the real route before hosted use. Do not cache/buffer responses or retry started streams: retrying runs another scan. Monitor counts/timeouts/provider quotas and memory without retaining bodies. [Duration limits](https://vercel.com/docs/functions/configuring-functions/duration), [streamed response guidance](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions)

## Quota database reachability

Only Next.js connects to quota MySQL. Hostinger's remote-access instructions require an allowed source IP and the supplied database hostname on port 3306; they do not establish that a particular shared database provides certificate-verified TLS or suitable restricted grants. Confirm both with the actual service before configuring Vercel. Keep DATABASE_SSL=true and a certificate-matching DNS hostname, adding the provider CA when required. A website HTTPS certificate is not proof of MySQL TLS. Do not disable certificate verification or send remote credentials over plaintext to make a connection work. [Hostinger remote MySQL](https://www.hostinger.com/support/1583546-how-to-set-up-remote-mysql-access-in-hostinger/)

Vercel's optional static egress IP feature currently requires Pro or Enterprise. Its documentation lists **$100/month per project on Pro plus regional Private Data Transfer**, separate from the VPS and plan; recheck pricing before choosing it. A database limited to one fixed source IP needs that feature or another reviewed connectivity design; the existing setup has not verified a hosted allowlist. Do not assume the operator PC/VPS IP is the source of Vercel's database connection. Shared-service connection limits must also cover every independently scaled Next.js pool. [Vercel static egress IPs](https://vercel.com/docs/networking/static-ips)

## Host verification before enabling

Run a genuine CPU scan: inspect fresh acquisition, exact coverage, model/profile, citations and incremental progress. Start another scan and verify acquisition runs again. Test a cited follow-up, browser disconnect, shutdown during active work, three concurrent operations and excess rejection. Verify no saved results appear after restart. Inspect listeners, ollama ps and service peak RSS/CPU counters during inference; avoid secret/body diagnostics.

Only after actual host checks and manual explanation review:

```bash
sudo systemctl enable traceforce-ollama.service traceforce-worker.service
```

SIGTERM/SIGINT stop admission, cancel active work and close the listener. No durable lease/job exists to recover. systemd allows 45 seconds before forced termination, restarting failures after ten seconds under startup limits. Stop before release/model changes; no migration or history backfill applies. [Lifecycle documentation](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)

These templates were prepared on Windows and **have not run on Linux/Hostinger**. Desktop CPU measurements and one-case review do not establish KVM 2 performance, broader accuracy, hosted capacity, TLS reachability or recovery behavior.
