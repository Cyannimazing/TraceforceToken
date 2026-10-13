# TraceForce Engine skills roadmap

Planning baseline: **2026-10-12**. **All skills below are Planned.** Priority indicates sequencing, not availability or completed validation.

This document lists workflows we may package as callable skills later. It is a design document, **not a `SKILL.md`**, and it creates or installs no skills. Existing project code does not make a proposed skill active. Create a skill when the workflow is sufficiently stable and recurring; give it bounded instructions, supporting references, and evaluated examples rather than a broad mandate to build the entire product.

**P0:** establish before live engine development or an affected security/database change. **P1:** create with the corresponding investigation capability. **P2:** create before production workers or a public operational launch.

## 1. `traceforge-foundation-architecture`

**Status:** Planned · **Priority:** P0

- **Trigger and scope:** Add or restructure Next.js routes, component boundaries, canonical metadata, public indexing, or shared Tailwind conventions. Covers the strict TypeScript web foundation and architectural placement; excludes blockchain detection and deployment execution.
- **Inputs:** Installed Next.js guides, current routes/configuration, CSS-first semantic theme, requested behavior, rendering/security policy, and deployment-origin settings.
- **Outputs:** A focused implementation or review with explicit server/client boundaries, typed component variants, shared tokens, canonical/metadata updates, and any architecture decision needing documentation.
- **Verification and dependencies:** Lint, strict typecheck, production build, static utility detection, relevant route/metadata tests, preview noindex checks, and CSP/rendering compatibility. Depends on project conventions and the security-review workflow for security policy changes.

## 2. `traceforge-source-verification`

**Status:** Planned · **Priority:** P0

- **Trigger and scope:** Select, integrate, upgrade, or replace a data provider. Verify its official documented capabilities and acquisition limits; exclude ownership conclusions and unattended purchases.
- **Inputs:** Target Base capability, official documentation, plan/access constraints, sample responses, acquisition budget, and current source registry.
- **Outputs:** A dated source assessment, typed adapter mapping, coverage/failure behavior, and updates distinguishing planned, configured, and validated capabilities.
- **Verification and dependencies:** Test chain ID, schemas, pagination/chunking, failure modes, and pinned live samples. Requires authorized credentials for live checks; documentation review alone must not mark integration validated. Depends on provenance and reliability-test specifications.

## 3. `traceforge-evidence-provenance`

**Status:** Planned · **Priority:** P0

- **Trigger and scope:** Define or change event normalization, evidence identity, acquisition coverage, or report serialization. Covers traceability and exact values; excludes graph interpretation.
- **Inputs:** Raw provider records, chain/block identity, query bounds, trace identifiers, token decimals, and schema/rule versions.
- **Outputs:** Normalized events, stable evidence IDs, coverage records, and auditable references from every event-derived claim.
- **Verification and dependencies:** Exact uint256 round trips; duplicate/order/fork fixtures; nullable unknown values; no credential leakage; resolvable evidence IDs. Depends on source adapters and explicit migrations when persisted fields change.

## 4. `traceforge-funding-tracing`

**Status:** Planned · **Priority:** P1

- **Trigger and scope:** Investigate native funding of specified wallets inside a declared window. Distinguish ordinary transactions from internal transfers; do not identify real-world owners.
- **Inputs:** Verified Base histories/receipts or traces, wallet list, per-wallet history coverage, and versioned public-service/hub labels.
- **Outputs:** First-observed funding paths with transaction evidence, checked/unexamined counts, qualified common-source associations, and explicit history limits.
- **Verification and dependencies:** Partial-history, failed-transaction, internal-funding, hub, zero-value, and ordering fixtures. Depends on source verification, provenance, and reliability tests. Lifetime-first language requires demonstrated complete eligible history.

## 5. `traceforge-wallet-graph`

**Status:** Planned · **Priority:** P1

- **Trigger and scope:** Construct or revise an evidence-backed relationship graph. Covers funding/direct-transfer edges and qualified groups; excludes timing-only clustering and same-owner assertions.
- **Inputs:** Canonical events and evidence IDs, verified infrastructure labels, eligibility rules, and declared coverage.
- **Outputs:** Deterministic nodes/edges, evidence-linked groups, confidence/limitations, and a serializable graph view model.
- **Verification and dependencies:** Hub/pool/mint/burn suppression, direct-payment alternatives, transitive-link caveats, disconnected-wallet and repeated-event fixtures. Depends on provenance and funding tracing; UI presentation is a separate skill.

## 6. `traceforge-accumulation-timeline`

**Status:** Planned · **Priority:** P1

- **Trigger and scope:** Describe when specified wallets acquired tokens or replay observed distributions. Covers bounded historical activity; excludes purchase, sniper, insider, or current-balance claims without their required evidence.
- **Inputs:** Ordered transfer/swap evidence, amount/decimal metadata, query coverage, and verified market-launch baseline when available.
- **Outputs:** Timestamped observations, exact net-flow series, qualified early-accumulation findings, and explicit unknown balances/baselines.
- **Verification and dependencies:** Launch-outside-lookback, missing-launch, multiple-pool, partial-history, rebase/nonstandard-token, and amount-precision fixtures. Depends on provenance, source verification, and reliability tests.

## 7. `traceforge-linked-selling-validation`

**Status:** Planned · **Priority:** P1

- **Trigger and scope:** Assess a proposed linked-wallet selling finding. Validate sales and prior relationships; never infer intent from nearby timestamps.
- **Inputs:** Successful receipts, authenticated supported pools, decoded swaps, reconciled wallet net flows, earlier relationship evidence, and the declared 600-second rolling interval.
- **Outputs:** Supported or rejected findings with every qualifying relationship and sale evidence ID, distinct-wallet counts, and alternative explanations.
- **Verification and dependencies:** Routed/multihop swaps, liquidity/internal moves, unrelated sellers, post-sale links, duplicate logs, and interval-boundary negatives. Depends on provenance, wallet graph, supported DEX adapters, and reliability tests.

## 8. `traceforge-data-reliability-tests`

**Status:** Planned · **Priority:** P0

- **Trigger and scope:** Add or change collection/analysis rules, or propose enabling live findings. Covers fixtures, cross-checks, and release evidence; excludes inventing an accuracy percentage.
- **Inputs:** Versioned rules, provider fixtures, independently reviewed positive/negative examples, coverage policy, and pinned live benchmark data when authorized.
- **Outputs:** Meaningful tests, discrepancy records, per-capability validation results, and a clear list of incomplete release gates.
- **Verification and dependencies:** Reproducibility, independent expected labels, outage/reorg recovery, false-positive cases, and source diversity. Depends on the reliability specification; missing live access must leave live validation incomplete.

## 9. `traceforge-mysql-migrations`

**Status:** Planned · **Priority:** P0

- **Trigger and scope:** Change persistent evidence/investigation schema or move a database host. Covers Drizzle/MySQL migrations and data-integrity checks; excludes automatic production execution.
- **Inputs:** Current schema/journal, proposed fields/constraints, host compatibility, retention needs, and backup/restore requirements.
- **Outputs:** Reviewed new migration, updated types, compatibility/rollback or recovery notes, and an explicit application procedure.
- **Verification and dependencies:** `db:check`, disposable-database migration tests, advisory-lock contention/release, exact raw-value round trips, constraints, restored migration history, and TLS certificate/hostname verification. Requires the intended database configuration for execution and security review for permissions/TLS changes.

## 10. `traceforge-security-review`

**Status:** Planned · **Priority:** P0

- **Trigger and scope:** Add a route, private operation, provider fetch, database access, dependency, external content, or security-header change. Review the actual change and threat boundary; do not invent an authentication system.
- **Inputs:** Diff, data flow, operation sensitivity, selected session/access model if any, deployment settings, and current policies.
- **Outputs:** Concrete findings and fixes for validation, authorization, resource limits, secret isolation, safe queries/output, SSRF, CSP, and relevant CSRF handling.
- **Verification and dependencies:** Targeted negative tests, production header/nonce checks, client-bundle secret checks, safe errors/logs, and dependency review. Depends on actual framework and host behavior; a checklist is not a penetration-test claim.

## 11. `traceforge-evidence-ui-accessibility`

**Status:** Planned · **Priority:** P1

- **Trigger and scope:** Build or review an investigation graph, timeline, evidence table, or report states. Covers understandable, accessible evidence interaction; excludes changing detection rules to fit a visual.
- **Inputs:** Validated report/view-model contract, source/coverage states, shared CSS-first Tailwind tokens, target viewports, and interaction requirements.
- **Outputs:** Responsive UI with reusable typed variants and complete static utility names, visible evidence/limitations, keyboard interaction, text/table alternatives to graphics, focus behavior, and clearly labeled synthetic/partial/stale states. Retain justified illustration CSS; prefer utilities for ordinary UI and avoid inline style attributes.
- **Verification and dependencies:** Browser keyboard tests, generated utility styles, semantic names, contrast/reduced-motion checks, responsive review, CSP compatibility, and evidence-link consistency. Depends on domain contracts and existing UI/UX guidance; automated scans do not replace manual interaction checks or imply a full CSS conversion.

## 12. `traceforge-worker-deployment-operations`

**Status:** Planned · **Priority:** P2

- **Trigger and scope:** Prepare, change, or troubleshoot production web/worker infrastructure. Covers reviewable configuration and operational recovery; production deployment or destructive changes still require existing authorization.
- **Inputs:** Host request/runtime limits, queue/database design, environment inventory, workload budgets, release artifact, and recovery objectives.
- **Outputs:** Deployment configuration, explicit migration/release steps, bounded worker concurrency/retries, monitoring, and incident/reorganization recovery procedures.
- **Verification and dependencies:** Staging startup, lease/retry/idempotence tests, outage recovery, TLS/connection-budget checks, nonce cache behavior, and backup restore exercise. Depends on implemented queue/workers, database migration workflow, security review, and live reliability gates.

## Packaging and evaluation

When a skill is implemented later, record its actual `SKILL.md` path, version, trigger examples and nonexamples, supporting scripts/references, required permissions, and evaluation results. Keep provider credentials and real private data out of the package. A skill may prepare reviewable work but must not silently turn a review request into paid provisioning, external publication, a production migration, or destructive operations.

These skills should reuse the project's [architecture](architecture.md), [source plan](data-sources.md), [reliability requirements](reliability.md), and [database instructions](database.md). Feature-specific skills build on the shared evidence rules rather than redefine what counts as funding, ownership, accumulation, or a sale. Update this roadmap only when status changes are supported by created artifacts and verification.
