export type DataSourceCategory =
  | "Chain RPC"
  | "Indexed history"
  | "Pool discovery"
  | "Market metadata";

export type DataSourceStatus = "available" | "planned";

export interface DataSource {
  id: string;
  name: string;
  category: DataSourceCategory;
  purpose: string;
  dataProvided: string[];
  officialUrl: string;
  docsUrl: string;
  status: DataSourceStatus;
  limitations: string[];
  verification: string[];
}

/** Documentation review date, not the date of a live provider health check. */
export const dataSourcesReviewedAt = "2026-10-12";

/** Adapter availability is separate from deployment configuration and live validation. */
export const dataSources: DataSource[] = [
  {
    id: "base-rpc", name: "Base JSON-RPC", category: "Chain RPC", status: "available",
    purpose: "Collect finalized Base blocks, ERC-20 transfers, successful receipts, token reads, and supported Uniswap v3 sale evidence.",
    dataProvided: ["Pinned finalized block hashes and timestamps", "Receipt-backed token transfer logs and exact raw amounts", "Authenticated supported pool calls and swap/consideration flows"],
    officialUrl: "https://www.base.org/", docsUrl: "https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_chainId",
    limitations: ["The operator configures an approved primary endpoint and up to two distinct alternatives, such as PublicNode or dRPC. Public endpoints have rate and method limits; recovery and acquisition budgets can leave partial coverage.", "Only the declared block window and examined wallets are covered. RPC logs do not establish lifetime native funding.", "A scan-wide provider label identifies sources used, not independent agreement about every observation.", "Sale classification supports a narrow single-pool Uniswap v3 path; multihop, unsupported DEXs, and ambiguous flows remain unclassified."],
    verification: ["Verify chain ID 8453, receipt success, log inclusion, and block hashes; recheck the pinned end block.", "Before replaying a recoverable request on a configured alternative, verify Base identity and every already-pinned range header's number, hash, and timestamp. All physical reads and recovery checks consume the shared budget; integrity disagreement and cancellation never trigger fallback.", "Authenticate a pool through the official Base factory getPool mapping.", "Require opposing wallet/pool token and ERC-20 consideration flows; retain every supporting evidence ID."],
  },
  {
    id: "alchemy",
    name: "Alchemy",
    category: "Chain RPC",
    purpose:
      "Optionally discover complete requested token history and top-level inbound native transactions through paginated Base indexing, then verify candidates through the pinned state RPC.",
    dataProvided: [
      "Token Transfer and supported DEX Swap event logs",
      "Transaction receipts and execution status",
      "Block hashes, timestamps, and token contract reads",
      "Explicitly configured alchemy_getAssetTransfers token and inbound native history pages",
    ],
    officialUrl: "https://www.alchemy.com/",
    docsUrl: "https://www.alchemy.com/docs/data/transfers-api/transfers-endpoints/alchemy-get-asset-transfers",
    status: "available",
    limitations: [
      "A configured Base endpoint and suitable plan are required; query ranges and response sizes are limited.",
      "Logs cover the requested block window. They do not identify owners or provide a complete wallet funding history.",
      "Recent blocks can change. A transfer into a pool is not enough to classify a sale.",
      "Indexed history requires BASE_ALCHEMY_RPC_URL and explicit transfer/funding source selection. Cursor exhaustion describes that source's requested query; it does not independently rule out omissions. Internal funding is not acquired by the external-transfer adapter.",
    ],
    verification: [
      "Check chain ID 8453 and retain each event's block hash, transaction hash, and log index.",
      "Match retained logs with successful receipts at the pinned block hash. Configured alternatives do not automatically provide independent corroboration.",
      "Decode a supported pool's Swap event and reconcile net token flow before labeling a sale.",
      "Check indexed lane chain and pinned headers, reject identity/range/cursor conflicts, and retain exact canonical receipt logs rather than indexed decimal amounts. Never move an active cursor to a fallback source.",
    ],
  },
  {
    id: "goplus",
    name: "GoPlus Security",
    category: "Indexed history",
    status: "available",
    purpose: "Add source-reported holder counts, holder candidates and selected contract checks when no Blockscout key is configured.",
    dataProvided: [
      "Reported holder count and documented Top10 holder addresses",
      "Creator address and nine source-reported contract/security checks, with unknown values preserved",
      "Fixed Base token-security endpoint and check time, separate from pinned balance evidence",
    ],
    officialUrl: "https://gopluslabs.io/",
    docsUrl: "https://docs.gopluslabs.io/reference/tokensecurityusingget_1",
    limitations: [
      "The documented Top10 list is a provider response limit, not an application wallet cap or a complete holder census. Other observed candidates remain eligible for verification.",
      "Counts, creator labels and contract checks are source reports, not verified ownership, a full audit, a safety verdict or proof that a token is harmless. Missing checks stay unknown.",
      "Access depends on operator rate/package and license terms, including attribution and commercial-use conditions. One successful anonymous read does not establish production permission or sustained availability.",
    ],
    verification: [
      "Require the exact requested Base token result key; reject mismatched identity. Bound the fixed-host request to 12 seconds by default and 1 MiB, with no redirects or hidden retries.",
      "Merge candidate addresses with observed participants, then verify exact balanceOf and totalSupply at the pinned finalized block. Ignore source balance and percentage fields for these determinations.",
      "Keep discovery within the shared acquisition-call budget and independent of RPC throttling; pinned balances still require available RPC capacity.",
    ],
  },
  {
    id: "blockscout",
    name: "Blockscout",
    category: "Indexed history",
    purpose:
      "Discover indexed holder candidates and, with configured PRO access, investigate top-level inbound native transactions.",
    dataProvided: [
      "Bounded pages of latest indexed holder addresses as candidates",
      "Inbound transaction references when PRO history access is configured",
      "Source context for subsequent RPC-verified funding and pinned balance reads",
    ],
    officialUrl: "https://www.blockscout.com/",
    docsUrl: "https://docs.blockscout.com/endpoint-overview",
    status: "available",
    limitations: [
      "Configured PRO access enables this holder path; otherwise GoPlus supplies holder candidates. Indexing can lag or omit addresses and is not a complete current or historical holder census; indexed amounts are not accepted as verified balances.",
      "The implemented PRO transaction-history adapter requires an API key. Without it, funding uses the bounded native RPC prefix or the explicitly selected SQD local-testing adapter.",
      "Blockscout's service supports additional explorer and internal-transaction features, but this adapter does not acquire internal traces or perform a contract audit. Unvisited pages leave history gaps.",
      "A shared exchange, bridge, or service funder does not establish common ownership.",
    ],
    verification: [
      "Validate token/address identity and pagination cursors; disclose the bounded page limit and any unreached history.",
      "Verify retained funding against canonical RPC transactions and successful receipts. Read holder balances separately at the pinned finalized block.",
      "Describe first funding as first observed unless complete eligible history has been demonstrated.",
    ],
  },
  {
    id: "sqd-portal",
    name: "SQD Portal (local testing)",
    category: "Indexed history",
    purpose:
      "Evaluate recipient-filtered top-level native funding discovery inside a declared finalized Base window.",
    dataProvided: [
      "Contiguous indexed block headers and inbound transaction candidates",
      "Bounded recipient queries with explicit searched ranges and partial-prefix coverage",
      "Funding observations retained only after canonical RPC transaction, receipt, and recipient-code checks",
    ],
    officialUrl: "https://sqd.dev/pricing/",
    docsUrl: "https://docs.sqd.dev/en/portal/evm/api",
    status: "available",
    limitations: [
      "Implemented for explicit local testing. SQD Public/Testing access is for development and evaluation; commercial production needs an appropriate paid access plan. This integration is not production-approved.",
      "Queries are bounded to 128 recipients and 1,000 headers per response, with shared call/time and response-size limits. Valid headers cannot independently disprove index omissions.",
      "Coverage concerns the declared indexed top-level window, not internal transfers, lifetime-first funding, EOA identity, or common ownership.",
      "A bounded native RPC prefix can recover an SQD attempt that completed no verified block, only when remaining budget and throttle state permit. Integrity disagreement and parent cancellation remain terminal.",
    ],
    verification: [
      "Validate page continuity and anchor its first and last headers to pinned RPC identities. Verify each retained positive candidate's transaction, successful receipt, canonical header, and historical/pinned recipient code.",
      "Commit evidence and coverage only after an entire block verifies; later availability failures preserve the completed prefix without including the failed block.",
      "One live historical single-block probe retained the known matching funding transaction after these checks. It validates that narrow adapter path, not a current whole scan, omission-free history, or production access.",
    ],
  },
  {
    id: "geckoterminal",
    name: "GeckoTerminal / CoinGecko",
    category: "Pool discovery",
    purpose:
      "Discover newly indexed Base liquidity pools and attach market context to a future launch feed.",
    dataProvided: [
      "Newly indexed pools on the selected network",
      "Pool addresses, token relationships, and reported creation time",
      "Reported liquidity, volume, and price context",
    ],
    officialUrl: "https://www.geckoterminal.com/",
    docsUrl: "https://docs.coingecko.com/demo/reference/latest-pools-network",
    status: "planned",
    limitations: [
      "A discovery feed is not an exhaustive record of every pool creation on Base.",
      "Availability, pagination, caching, and access depend on the selected API plan.",
      "A pool creation timestamp does not establish a token's first market launch or an individual wallet's trade.",
    ],
    verification: [
      "Match network, pool address, and both token contracts before accepting a discovery item.",
      "Check the pool contract and factory event where supported; retain the discovery fetch time separately.",
      "Deduplicate pools and disclose gaps between polling runs.",
    ],
  },
  {
    id: "dexscreener",
    name: "DEX Screener",
    category: "Market metadata",
    purpose:
      "Find source-reported website links and a market snapshot for the exact Base token in one bounded listing request.",
    dataProvided: [
      "Website URLs from matching Base-token pair listings",
      "Pair addresses supporting each reported website",
      "Selected-pair USD price, market cap, liquidity, 24-hour volume and price change when reported",
      "Reported pair creation time, distinct from token launch time",
      "Source endpoint, check time, and unavailable versus not-listed status",
    ],
    officialUrl: "https://dexscreener.com/",
    docsUrl: "https://docs.dexscreener.com/api/reference",
    status: "available",
    limitations: [
      "A reported website does not prove official ownership, project identity, legitimacy, or safety. Absence does not prove the token has no website.",
      "Listings may be absent, stale, or disagree across pools. The bounded request preserves distinct reported URLs and their pair references.",
      "Market values are third-party estimates from one selected pair, not verified supply, holder balances, wallet trades, or investment guidance. Missing metrics remain unknown; FDV never substitutes for market cap.",
      "Pair creation time does not establish token launch or age. Unsupported 32-byte pool IDs are skipped; website contents and social profiles are not crawled.",
    ],
    verification: [
      "Require chain ID base and the exact requested base-token contract; quote-token listings cannot attribute a website to the requested token.",
      "Show the fixed API source, check time, and pair references. Keep third-party metadata separate from transaction evidence and AI findings.",
      "Select the matching address-based pair with the greatest valid reported liquidity, using deterministic ties. Keep every metric tied to that pair and retain price as a decimal string.",
      "Accept only bounded public HTTPS links without embedded credentials; never fetch a returned website URL.",
    ],
  },
];
