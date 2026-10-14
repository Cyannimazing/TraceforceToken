# Optional one-VPS cohosting profile

Prepared **2026-10-12**; **not installed, benchmarked, or verified on Linux/Hostinger**. This profile places MySQL Community **8.4 LTS**, one stateless Node engine, and private Ollama on the same Hostinger KVM 2. Next.js remains on Vercel. It replaces the engine-only resource budget; use one profile at a time. It does not require a separate database hosting subscription, but secure Vercel database connectivity can have its own cost.

Use a clean **Ubuntu 24.04 LTS x86-64** host with unified cgroup v2 and patched **Node.js 24 LTS** (22 LTS also satisfies this project's `>=22 <25` range). MySQL lists Ubuntu 24.04 x86-64 for 8.4, and Node's current release table lists both 22 and 24 as LTS. Do not substitute Ubuntu's default MySQL package without checking its major version. Do not replace an existing MariaDB/data directory with these installation commands. [MySQL supported platforms](https://www.mysql.com/support/supportedplatforms/database.html), [Node releases](https://nodejs.org/en/about/previous-releases)

## Boundaries and resource budget

Vercel connects to MySQL only for opaque anonymous quota counters. The Node engine retains the base unit's database-environment exclusions and has **no database credentials**, even when the database is on the same machine. No scan parameters, reports, evidence, or chat enter MySQL. The existing committed migrations still create legacy compatibility tables; the Vercel runtime account receives no privileges on them.

| Service | CPU ceiling | MemoryHigh | MemoryMax |
| --- | --- | --- | --- |
| Ollama | 140% | 4352 MiB | 4608 MiB |
| Node engine | 25% | 512 MiB | 768 MiB |
| MySQL | 20% | 640 MiB | 768 MiB |
| Total hard ceilings | 185% | — | 6144 MiB / 6 GiB |

On two vCPUs, 200% represents both CPUs. The service ceilings leave nominal 15% of one CPU, about 7.5% of host CPU capacity, plus approximately **1.56 decimal GB** of a marketed 8 GB for kernel, nginx, SSH and other processes. These are ceilings, not reservations or proof of fit. Check actual `MemTotal`, cgroup support, other agents/services and peak use; caches/kernel allocations and operational tasks also need headroom. No Next.js build, second model/process, backup compression, package upgrade or restore is budgeted concurrently. [systemd resource controls](https://github.com/systemd/systemd/blob/main/man/systemd.resource-control.xml)

Keep the named `traceforce-investigator` model, qwen3:4b-instruct-2507-q4_K_M, profile 1.5.0, context 4096, two CPU threads, GPU layers 0, one loaded model and one inference. The original cloud-off/loopback settings remain. This smaller memory/CPU ceiling may kill or slow inference. The existing AI 120-second and scan 270-second budgets are unchanged: **measure cold/warm latency and concurrent acquisition before enabling traffic**. A model file size or desktop result cannot establish VPS RSS/latency.

MySQL starts with a 256 MiB InnoDB buffer pool, 20 ordinary connections, small explicit caches/buffers and a 32 MiB TempTable RAM threshold. Performance Schema, general/slow query logs and binary logging are disabled in this quota-only profile; diagnostics and point-in-time recovery are consequently reduced. These settings do not mathematically bound every allocation: systemd's 768 MiB maximum is the final kill boundary. Review other included config files and `mysqld-auto.cnf` persisted settings; a conflicting override can defeat the intended sizes. [MySQL server variables](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html), [InnoDB settings](https://dev.mysql.com/doc/refman/8.4/en/innodb-parameters.html)

## 1. Resolve the network gate first

The reviewed path is direct **certificate-verified MySQL TLS** from Vercel through a firewall allowing only the project's fixed outbound IPs. Vercel Static IPs are currently a paid Pro/Enterprise feature; documentation lists **$100/month per project on Pro plus regional Private Data Transfer**, beyond the VPS/plan. Recheck pricing before purchase. Their IPs are shared egress, not application authentication. Configure every actual function region and obtain its real IP pair before opening a port. No static IP is assumed for Hobby. If this connectivity is unavailable, **leave MySQL local-only**; a separately reviewed HTTPS quota service or other private connectivity would require implementation and is not supplied here. Do not permit `0.0.0.0/0`, `::/0`, or all Vercel/AWS ranges to avoid that gate. [Vercel Static IPs](https://vercel.com/docs/networking/static-ips)

Use a real operator-controlled database DNS name distinct from the engine's HTTPS endpoint. Its MySQL certificate must contain that DNS name in Subject Alternative Name. This is MySQL TLS on 3306, not nginx HTTPS. Keep 8787 and 11434 loopback-only; reuse the exact protected `/scan` and `/ask` HTTPS proxy in the [base runbook](../README.md). Never expose database root remotely.

Before installing packages, configure Hostinger's network firewall to deny incoming 3306, 33060, 8787 and 11434. Preserve a tested SSH access rule. No commands here modify a live firewall automatically.

## 2. Install a reviewed MySQL 8.4 package

From the repository root on the target host, first inspect the machine. `stat` should report `cgroup2fs`; confirm two CPUs and actual memory before using these limits:

```bash
cat /etc/os-release
uname -m
nproc
free -h
stat -fc %T /sys/fs/cgroup
systemd --version
node --version
```

Follow MySQL's official APT repository package download/signature instructions. Download the current reviewed `mysql-apt-config` DEB rather than copying a stale version/signing key. Select the **8.4 LTS** series in its dialog. The following commands are explicit operator steps, not app startup actions:

```bash
sudo dpkg -i /path/to/reviewed/mysql-apt-config_VERSION_all.deb
sudo apt-get update
apt-cache policy mysql-community-server mysql-server
sudo apt-get install mysql-server
mysql --version
sudo systemctl stop mysql.service
```

Require an 8.4.x candidate from the intended signed repository. APT normally starts/enables MySQL during installation, so keep network denial in place and Ollama/engine stopped during preparation. Set a private local administrator credential or explicitly reviewed socket authentication; run `mysql_secure_installation` interactively to review anonymous users, remote root and the test database. Do not put passwords in command arguments, source control or shell history. [Official APT installation](https://dev.mysql.com/doc/mysql-apt-repo-quick-guide/en/)

## 3. Install a hostname-valid certificate

Use a reviewed CA-issued server certificate. MySQL's automatically generated self-signed certificates do not supply the intended hostname identity. A private operator CA is acceptable when its public certificate is explicitly trusted by Vercel. Keep its signing key **off the VPS**. For local TLS migration probes, also include `IP:127.0.0.1` in the server SAN, or use a reviewed local DNS mapping to its certified name. [MySQL TLS and VERIFY_IDENTITY](https://dev.mysql.com/doc/refman/8.4/en/using-encrypted-connections.html)

After securely transferring only the public CA, server certificate/chain and server private key, install them:

```bash
sudo install -d -o root -g mysql -m 0750 /etc/mysql/tls
sudo install -o root -g mysql -m 0644 /secure/staging/ca.pem /etc/mysql/tls/ca.pem
sudo install -o root -g mysql -m 0644 /secure/staging/server-cert.pem /etc/mysql/tls/server-cert.pem
sudo install -o root -g mysql -m 0640 /secure/staging/server-key.pem /etc/mysql/tls/server-key.pem
openssl verify -CAfile /etc/mysql/tls/ca.pem /etc/mysql/tls/server-cert.pem
openssl x509 -in /etc/mysql/tls/server-cert.pem -noout -dates -ext subjectAltName
```

Use the package's normal MySQL data directory and AppArmor policy. If it denies these certificate paths, add only the reviewed certificate reads in its local policy; do not disable AppArmor. Arrange certificate expiry monitoring and a tested renewal/reload procedure. Never copy a private CA key, server key or client password into Vercel's `DATABASE_CA_CERT`.

## 4. Install this profile explicitly

Install/review the two base engine/Ollama units using the [base runbook](../README.md), without starting them yet. Verify the MySQL package's service is named `mysql.service` and its config includes `/etc/mysql/mysql.conf.d/`. Then:

```bash
sudo install -d -m 0755 /etc/systemd/system/traceforce-ollama.service.d
sudo install -d -m 0755 /etc/systemd/system/traceforce-worker.service.d
sudo install -d -m 0755 /etc/systemd/system/mysql.service.d
sudo install -o root -g root -m 0644 deploy/linux/cohost/traceforce-ollama.conf /etc/systemd/system/traceforce-ollama.service.d/50-cohost.conf
sudo install -o root -g root -m 0644 deploy/linux/cohost/traceforce-engine.conf /etc/systemd/system/traceforce-worker.service.d/50-cohost.conf
sudo install -o root -g root -m 0644 deploy/linux/cohost/mysql.service.conf /etc/systemd/system/mysql.service.d/50-traceforce-cohost.conf
sudo install -o root -g root -m 0644 deploy/linux/cohost/mysql.cnf /etc/mysql/mysql.conf.d/zz-traceforce-cohost.cnf
sudo systemctl daemon-reload
sudo systemd-analyze verify mysql.service traceforce-ollama.service traceforce-worker.service
sudo -u mysql /usr/sbin/mysqld --validate-config
sudo systemctl start mysql.service
sudo systemctl show mysql.service traceforce-ollama.service traceforce-worker.service -p CPUQuotaPerSecUSec -p MemoryHigh -p MemoryMax -p MemorySwapMax
sudo ss -lntp
```

At this point MySQL must still listen only on 127.0.0.1:3306, with X Protocol disabled. `--validate-config` checks options, not successful TLS connectivity or resource fit. Inspect effective settings after startup through the local administrator socket. Do not delete/reset an existing data directory to solve a startup error.

## 5. Create schema and scoped accounts

Use a **fresh** application database such as `traceforce` on the VPS; do not import local legacy reports/evidence merely to deploy anonymous quotas. From a private administrator session with client history disabled, run explicit statements. MySQL's generated random passwords are displayed once: capture them only in a secure credential store, never verification logs.

```bash
MYSQL_HISTFILE=/dev/null mysql --protocol=SOCKET --user=root --password
```

```sql
CREATE DATABASE traceforce CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'traceforce_migrate'@'127.0.0.1'
  IDENTIFIED WITH caching_sha2_password BY RANDOM PASSWORD
  REQUIRE SSL WITH MAX_USER_CONNECTIONS 1 ACCOUNT LOCK;
GRANT ALL PRIVILEGES ON traceforce.* TO 'traceforce_migrate'@'127.0.0.1';
```

This migration account is local-only, schema-scoped, locked outside deliberate migration windows, and never copied to Vercel or engine environments. Save a separate root-owned mode-0600 migration environment outside the release tree containing `DATABASE_MIGRATION_URL=mysql://traceforce_migrate:PERCENT_ENCODED_PASSWORD@127.0.0.1:3306/traceforce`, `DATABASE_SSL=true`, and the public `DATABASE_CA_CERT` PEM (escaped newlines are supported). Use a certificate with the loopback SAN noted above. Do not reuse worker.env or local `.env.local`; run from a clean reviewed release with neither `.env.local` nor `.env` present.

Unlock explicitly in the administrator session:

```sql
ALTER USER 'traceforce_migrate'@'127.0.0.1' ACCOUNT UNLOCK;
```

Then, as the reviewed deployer, inject that one-use private environment via the deployment secret mechanism. One concrete root-run transient service can load it without exposing values in process arguments (replace the release path and account with the verified deployment values):

```bash
sudo systemd-run --wait --collect --pipe --unit=traceforce-db-migrate \
  --property=Type=exec --property=User=traceforce \
  --property=WorkingDirectory=/opt/traceforce/current \
  --property=EnvironmentFile=/etc/traceforce/migration.env \
  /usr/bin/npm run db:migrate
```

The `traceforce` account needs read-only release access, not permission to read the root-only secret file directly; systemd loads the environment. Migration credentials exist in that short-lived process, not the engine. Review committed SQL/snapshots/journal 0000–0002 first. No DDL runs at app startup/build/request time. Relock the account after success **or failure** from the administrator session:

```sql
ALTER USER 'traceforce_migrate'@'127.0.0.1' ACCOUNT LOCK;
```

After migration, create the Vercel account for **each exact approved egress IP**, using one independently generated private password per shared account identity. For example, replace the documentation-only IP below before execution:

```sql
CREATE USER 'traceforce_web'@'198.51.100.10'
  IDENTIFIED WITH caching_sha2_password BY RANDOM PASSWORD
  REQUIRE SSL WITH MAX_USER_CONNECTIONS 6;
GRANT SELECT, INSERT, UPDATE ON traceforce.investigation_queue_guard
  TO 'traceforce_web'@'198.51.100.10';
GRANT SELECT, INSERT, UPDATE, DELETE ON traceforce.investigation_scan_admission
  TO 'traceforce_web'@'198.51.100.10';
SHOW GRANTS FOR 'traceforce_web'@'198.51.100.10';
```

For Vercel's second source IP, create the same username with its exact host and the **same private password**, and repeat only these table grants. Enter private SQL through a history-disabled administrator session; do not commit its password. This allows the single Vercel DATABASE_URL credential to work through either egress IP. Six connections per host account budgets 12 for a two-IP region; additional regions/IPs need a revised total. The SQL grants are deliberately narrower than the local development account. No `FILE`, `PROCESS`, global privileges, schema DDL, legacy-report access, or grant option is given. [MySQL account and connection limits](https://dev.mysql.com/doc/refman/8.4/en/create-user.html)

## 6. Open only the approved database route

Add the exact actual interface IP to `bind_address` alongside 127.0.0.1, keeping all wildcard listeners absent. Obtain it with `ip -brief address`; a NAT public IP not assigned locally is not a valid bind target. Ensure both the Hostinger firewall and the host firewall permit 3306 only from approved Vercel egress IPs. For an already reviewed UFW installation, the rule shape is:

```bash
# Replace the documentation-only addresses; repeat for each approved egress IP.
sudo ufw allow proto tcp from 198.51.100.10 to 203.0.113.20 port 3306
sudo ufw status verbose
sudo -u mysql /usr/sbin/mysqld --validate-config
sudo systemctl restart mysql.service
sudo ss -lntp
```

UFW must already have default incoming deny, correct IPv6 handling, and a tested SSH rule; this command does not enable/reconfigure it. The provider firewall must match. Verify a nonallowlisted internet host cannot connect. Keep MySQL root/admin socket-only; review `mysql.user` to confirm no remote root/anonymous entries. Do not add wildcard user hosts or broadly open 3306 as a workaround.

Configure Vercel **server-only**, not NEXT_PUBLIC variables:

```dotenv
DATABASE_URL=mysql://traceforce_web:PERCENT_ENCODED_PASSWORD@YOUR_CERTIFIED_DATABASE_DNS:3306/traceforce
DATABASE_SSL=true
DATABASE_CA_CERT=PUBLIC_CA_PEM_WITH_ESCAPED_NEWLINES
DATABASE_POOL_SIZE=2
```

Use the same real database DNS name as its certificate. URL-encode the private password. Vercel receives no migration credentials. Preserve SITE_URL, RATE_LIMIT_SECRET and protected engine URL/secret as described in the base runbook. TLS verification remains `rejectUnauthorized=true` plus hostname identity in the existing mysql2 configuration.

Pool size 2 is **per independently scaled Next.js process**, not a global cap. The 20-connection server limit and per-account limits fail closed when exceeded; they do not coordinate Vercel scaling. Plan around all deployment regions/previews/instances and confirm quota rejection/recovery under load before public launch. Keep previews from consuming production quota credentials. If the capped server cannot sustain the actual pool count, revisit capacity/connectivity instead of silently enlarging buffers/connections. [Vercel connection pooling](https://vercel.com/guides/connection-pooling-with-functions)

From an allowlisted operator test route or actual Vercel deployment, verify using the MySQL 8.4 client with a private password prompt:

```bash
mysql --host=YOUR_CERTIFIED_DATABASE_DNS --port=3306 --user=traceforce_web --password \
  --ssl-mode=VERIFY_IDENTITY --ssl-ca=/secure/operator/ca.pem traceforce \
  --execute="SHOW SESSION STATUS LIKE 'Ssl_cipher'; SELECT 1;"
```

Do not temporarily allow the whole internet for this probe. Confirm the real Vercel request works, an incorrect CA/hostname fails, and runtime DDL/legacy table reads are denied. The standalone engine must still have no database variables or DB network dependency.

## 7. Measure before enabling public traffic

Keep application/model setup separate from startup. Follow the base runbook to create the exact named model and start the services, then record cold/warm scan durations, main explanation quality, question path, cancellation and simultaneous quota access while inference runs. Run three admitted scans and an excess request, not merely `/health`. Verify the 120/270/285/300-second boundaries on the actual host and Vercel route.

```bash
sudo systemctl show mysql.service traceforce-ollama.service traceforce-worker.service \
  -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec -p Result -p NRestarts
free -h
df -h /var/lib/mysql /var/lib/traceforce-ollama /opt/traceforce
sudo systemd-cgtop --iterations=3
```

Check cgroup `memory.events`/`cpu.stat`, swap activity and kernel OOM logs without recording request bodies or secrets. Observe MySQL `Threads_connected`, `Max_used_connections` and `Aborted_connects` from the local admin session. Service CPU/memory counters do not prove correctness or sustained throughput. Only after verified operation enable the units deliberately; MySQL APT may already have enabled its own service.

The single VPS is a shared failure domain: database contention/OOM/reboot can stop quota admission and inference together. Quota buckets are short-lived and not scan history; a restored database or empty rebuilt database can change current limits. Versioned migrations are not data backups. Choose and test backup/restore for any remaining legacy/operator data, certificate keys/configuration and credentials separately; do not introduce server report/evidence storage. Binary logging is off here, so point-in-time recovery is unavailable. Pause inference/traffic for memory-heavy backup, restore, major upgrades and release changes. Monitor disk free space, model downloads, journal/MySQL log growth and certificate expiry; the marketed 100 GB includes OS/releases/models/database/logs. Never delete the data directory or existing records as an automatic recovery step.

To return to the engine-only resource profile, stop traffic/services and explicitly remove only the three installed cohost drop-ins, then reload systemd. Do not remove a live database/config/data or run this profile alongside the old larger Ollama ceiling. No host commands, credentials, migrations or data were changed while preparing these files.
