# SWARM reference review

Reviewed **2026-10-12** against the official [SWARM site](https://swarmengine.tech/), [public documentation](https://swarmengine.tech/docs), [changelog](https://swarmengine.tech/api/molt), and its publicly served application. This distinguishes visible behavior and published claims from backend internals we cannot inspect. No private APIs or credentials were used. Public source inspection did not submit scans; the separate anonymous Playwright report inspection is recorded below.

## Report actually inspected

The current reproducible Playwright capture completed at **2026-10-12 09:27:01.708 UTC** for the same user-selected Base `openhuman` contract. Run `npm run inspect:swarm` to repeat public inspection. Bounded ignored artifacts are under `.artifacts/swarm-reference/current-1641ea6e/`: `report-desktop.png`, `report-mobile.png`, six section captures, settled report text and `inspection.json`. Council settled with eight visible turns. This capture opened an existing report and did not request a fresh scan.

The desktop reference has 1,196 px of report content at a 1,440 px viewport, a large bordered identity/stage header, separate six-column market strip, and approximately 60/40 graph/sidebar. The graph is about 715 by 560 px; the sidebar stacks gauge, verdict/X-ray and six-part score/rules. Lower sections contain Council, replay, wallet groups, contract checks, holders, infrastructure, historical features and sharing. TraceForce now follows this report hierarchy with square panels and its green/slate semantic theme. Unknown scores/probabilities remain visibly unknown; model/profile/evidence context is factual. Additional dataset comparisons and cited acquisition details support that hierarchy.

Matching report layout does not authorize copying unsupported assertions. For example, the captured Council's renunciation wording went beyond a displayed missing `owner()` check. TraceForce's core conclusions remain based on acquired evidence. Swarm's report-memory and cross-token histories also do not override this project's request-owned, browser-snapshot-only storage policy.

The browser review opened the Base `openhuman` report for `0x1641ea6eab36969fe11d71e6eb8f102889c735e1`. Local ignored artifacts are in `.artifacts/swarm-reference/`: `report-full.png`, `report-mobile.png`, `section-01.png` through `section-06.png`, `visible-report.txt`, and entry/progress captures.

| Visible section | What the inspected report displayed |
| --- | --- |
| Token and market | Contract/explorer/DEX links, price, market cap, liquidity, 24-hour volume/change, age and a reported count of 13 holders |
| Wallet graph | 11 analyzed holder rows and 11 claimed real hands; funding, transfer, timing, creator and freshness legends |
| Score and Judge | Score 45/DANGER, AVOID, avoid/caution/ok masses, decision X-ray, model label, receipt, latency and cost fields |
| Breakdown and rules | Swarm 30, fresh 20, insiders 15, concentration 15, snipers 10, dev 10; concentration/creator/liquidity concerns in this report |
| Council and replay | Initial text capture showed convening; settled section screenshots showed Judge, Scout and Tracer turns, suggested questions, voice/replay controls, holder timeline and supply-share plot |
| Holders and contract | Holder balances/entry/flags, infrastructure exclusions, and three displayed contract checks; one holder carried a sniper label |
| History and sharing | Earlier-scan memory, rug replay, creator history limited to tokens SWARM has scanned, SVG/link/social sharing and scan history |

These are interface observations, not independent validation of its holder census, ownership labels, security conclusions or sniper classification. Playwright measured approximately **4.6 seconds** from fresh-scan submission to the result response; the footer reported **4 seconds and 32 requests**. Its crawl log explicitly reused 34 transfers from memory and read newer blocks, and the same token had earlier scans. This is a measured incremental rescan, not a cold, uncached acquisition benchmark.

## Data sources and acquisition claims

The [public RPC status endpoint](https://swarmengine.tech/api/status/rpc) disclosed Alchemy hostnames for Base, Ethereum and Robinhood Chain, NodeReal for BNB Chain, and Helius for Solana in the recorded response. This establishes that disclosed RPC inventory at review time, not every upstream service or each record's acquisition source.

The [changelog](https://swarmengine.tech/api/molt) says Base holders are reconstructed from full token-transfer history, describes incremental rescans that reread the last 64 blocks, and announces backup RPCs and Blockscout PRO support. Its Ethereum note explicitly limits very busy histories above 150,000 transfers. These are public product claims; we did not reproduce the full-history algorithm. Public application code also references GeckoTerminal for its launch radar. An explorer or DEXScreener outbound link alone does not establish which API supplied market data.

The read-only source artifacts are `.artifacts/swarm-public-app-current.js`, `.artifacts/swarm-public-source-review.json` (six GETs recorded at `2026-10-12T06:47:29.858Z`), and `.artifacts/swarm-cached-report-shape.json`. A separate cached Base response exposed 25,404 reported holders alongside 47 analyzed rows and 32 unread rows. Reported global count, analyzed wallets and grouped hands are distinct measures; none should silently replace another.

## Judge, escalation and Council

The [public application](https://swarmengine.tech/assets/app.js?v=1791783488) renders a server-provided Judge object containing a decision, normalized masses, features, evidence increments, threshold, receipt, latency, cost and an escalation flag. Its X-ray shows how evidence increments combine into the displayed avoid mass. This supports a structured feature/rule assessment boundary; it does **not** reveal the backend implementation or prove that the label `swarm-judge-1` denotes trained neural weights.

The escalation button copies a compact facts packet and a prompt to the clipboard. Its text includes: “SWARM's fast judge was not confident enough and escalated this case to you.” That click handler does not itself issue an LLM request.

Council uses GET `/api/council/{chain}/{token}` for named turns and suggestions, and the same route with `?q=` for a follow-up. The frontend recognizes Scout, Tracer, Linker, Auditor and Judge roles. It receives turn text and then animates it locally, with optional browser speech synthesis; the animation does not prove backend token streaming, independent agents or parallel inference. The [changelog](https://swarmengine.tech/api/molt) announces Council leaving beta on October 9 and describes discussion from scan data, while the inspected interface still showed beta. The provider, model weights, prompts and generation strategy remain unknown.

## TraceForce implementation direction and remaining gaps

Keep deterministic acquisition, evidence validation and review rules separate from commentary. The focused local design uses **one genuine Ollama inference** to cover funding, wallet connections, earliest-observed accumulation and selling evidence, followed by evidence-grounded questions. Multiple perspectives in that answer do not represent independently running agents. With two CPU threads and one inference slot, speculative multi-model Council execution would add contention; CPU-only VPS latency is still unverified.

The collector now overlaps its single bounded DEX metadata read with chain acquisition after provider-destination validation. Both share cancellation and the provider deadline. This removes the mandatory sequential metadata wait; no live speed improvement has been measured for this change, and acquisition or model generation can still dominate latency.

TraceForce must continue to disclose bounded transfer/funding coverage and source-reported holder context. It does not yet establish a token-wide launch reference, receipt-verified launch-window sniper candidates, a full holder census, lifetime wallet histories, SWARM's private scoring model or equivalent token audit. Earliest-observed accumulation in a recent scan window must not be relabeled launch buying. Market figures and contract flags cannot fill those gaps or justify an invented complete score. Unlike SWARM's advertised incremental history, the current user requirement is fresh request-owned acquisition with no server report/evidence history; explicit visitor browser snapshots are the only report storage path.
